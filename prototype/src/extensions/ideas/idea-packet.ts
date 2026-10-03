// Idea marking and Work Packet drafting domain model for Workbench.
// Enriches candidate ideas and draft work packets with supplied session context.

import { generateULID } from "../../kernel/mod.ts";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import {
  closeDanglingFences,
  sanitizeCriterion,
  sanitizeSingleLine,
} from "./idea-packet-markdown.ts";
import type {
  WorkbenchIdea,
  WorkbenchWorkPacket,
} from "./idea-packet-types.ts";

export { formatWorkPacketMarkdown } from "./idea-packet-markdown.ts";
export type {
  WorkbenchIdea,
  WorkbenchWorkPacket,
  WorkbenchWorkPacketSourceContext,
  WorkbenchWorkPacketVerifierProvenance,
} from "./idea-packet-types.ts";

export function stripOuterQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function validateIdentifier(id: string, fieldName = "identifier"): string {
  if (typeof id !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (id.length === 0) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (id.length > 256) {
    throw new Error(`${fieldName} exceeds maximum length of 256 characters`);
  }
  if (/\s|[\x00-\x1F\x7F-\x9F\x1B]/.test(id)) {
    throw new Error(
      `${fieldName} cannot contain control characters or whitespace`,
    );
  }
  return id;
}

function boundedCloneForJson(
  val: unknown,
  depth = 0,
  state = { totalBytes: 0, budget: 4096, nodeCount: 0, maxNodes: 100 },
): unknown {
  state.nodeCount++;
  if (
    state.nodeCount > state.maxNodes || state.totalBytes >= state.budget ||
    depth > 3
  ) {
    state.totalBytes += 13;
    return "[truncated]";
  }
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    const s = val.length > 500 ? val.slice(0, 500) + "...[truncated]" : val;
    state.totalBytes += s.length;
    return s;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    state.totalBytes += 8;
    return val;
  }
  if (Array.isArray(val)) {
    state.totalBytes += 2;
    const out: unknown[] = [];
    for (let i = 0; i < val.length && i < 20; i++) {
      if (
        state.nodeCount > state.maxNodes || state.totalBytes >= state.budget
      ) {
        state.totalBytes += 13;
        out.push("[truncated]");
        break;
      }
      state.totalBytes += 2;
      out.push(boundedCloneForJson(val[i], depth + 1, state));
    }
    if (val.length > 20 && out[out.length - 1] !== "[truncated]") {
      state.totalBytes += 13;
      out.push("[truncated]");
    }
    return out;
  }
  if (typeof val === "object") {
    state.totalBytes += 2;
    const out: Record<string, unknown> = {};
    const record = val as Record<string, unknown>;
    let count = 0;
    let totalScanned = 0;
    for (const k in record) {
      if (
        ++totalScanned > 50 ||
        count >= 20 ||
        state.nodeCount > state.maxNodes ||
        state.totalBytes >= state.budget
      ) {
        out["_truncated"] = true;
        state.totalBytes += 18;
        break;
      }
      if (Object.prototype.hasOwnProperty.call(record, k)) {
        const key = k.length > 100 ? k.slice(0, 97) + "..." : k;
        state.totalBytes += key.length + 4;
        out[key] = boundedCloneForJson(
          record[k],
          depth + 1,
          state,
        );
        count++;
      }
    }
    return out;
  }
  const s = String(val).slice(0, 100);
  state.totalBytes += s.length;
  return s;
}

function safeBoundedJson(obj: unknown, maxLen = 4000): string {
  if (obj === null || obj === undefined) return "{}";
  try {
    const bounded = boundedCloneForJson(obj, 0, {
      totalBytes: 0,
      budget: maxLen,
      nodeCount: 0,
      maxNodes: 100,
    });
    const str = JSON.stringify(bounded);
    if (str.length <= maxLen) return str;
    return str.slice(0, Math.max(0, maxLen - 15)) + "...[truncated]";
  } catch {
    return "[unserializable arguments]";
  }
}

export class IdeaPacketRegistry {
  private readonly ideasById = new Map<string, WorkbenchIdea>();
  private readonly ideasBySession = new Map<string, WorkbenchIdea[]>();
  private readonly packetsById = new Map<string, WorkbenchWorkPacket>();
  private readonly packetsBySession = new Map<string, WorkbenchWorkPacket[]>();
  private readonly knownIdeaOwners = new Map<string, string>();
  private readonly knownPacketOwners = new Map<string, string>();
  private readonly maxSessions = 100;
  private readonly maxEntriesPerSession = 50;
  private readonly maxTombstones = 20000;

  private hasRetainedPacketForIdea(ideaId: string): boolean {
    for (const packet of this.packetsById.values()) {
      if (packet.ideaId === ideaId) return true;
    }
    return false;
  }

  private cloneIdea(idea: WorkbenchIdea): WorkbenchIdea {
    return { ...idea };
  }

  private clonePacket(packet: WorkbenchWorkPacket): WorkbenchWorkPacket {
    return {
      ...packet,
      sourceContext: {
        ...packet.sourceContext,
        contextSources: [...packet.sourceContext.contextSources],
      },
      proposedAcceptanceCriteria: [...packet.proposedAcceptanceCriteria],
      verifierProvenance: { ...packet.verifierProvenance },
    };
  }

  registerIdea(idea: WorkbenchIdea): void {
    const rawLabel = idea.label.length > 512
      ? idea.label.slice(0, 512)
      : idea.label;
    const rawDesc = idea.description.length > 4000
      ? idea.description.slice(0, 4000)
      : idea.description;
    const rawCreated = idea.createdAt.length > 128
      ? idea.createdAt.slice(0, 128)
      : idea.createdAt;
    const cleanLabel = sanitizeSingleLine(rawLabel).slice(0, 256);
    if (cleanLabel.length === 0) {
      throw new Error("idea label cannot be empty or whitespace-only");
    }
    const cleanDesc = rawDesc.replace(
      /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g,
      " ",
    ).trim().slice(0, 2000);
    const sanitized: WorkbenchIdea = {
      ideaId: validateIdentifier(idea.ideaId, "ideaId"),
      sessionId: validateIdentifier(idea.sessionId, "sessionId"),
      eventId: idea.eventId
        ? validateIdentifier(idea.eventId, "eventId")
        : null,
      label: cleanLabel,
      description: cleanDesc,
      createdAt: rawCreated.trim().slice(0, 64),
    };

    const knownOwner = this.knownIdeaOwners.get(sanitized.ideaId);
    if (knownOwner && knownOwner !== sanitized.sessionId) {
      throw new Error(
        `cannot re-register idea "${sanitized.ideaId}" under session "${sanitized.sessionId}" because it is already registered under session "${knownOwner}"`,
      );
    }

    const existing = this.ideasById.get(sanitized.ideaId);
    if (existing) {
      if (existing.sessionId !== sanitized.sessionId) {
        throw new Error(
          `cannot re-register idea "${sanitized.ideaId}" under session "${sanitized.sessionId}" because it is already registered under session "${existing.sessionId}"`,
        );
      }
      const prevList = this.ideasBySession.get(existing.sessionId);
      if (prevList) {
        const idx = prevList.findIndex((i) => i.ideaId === sanitized.ideaId);
        if (idx >= 0) prevList.splice(idx, 1);
      }
    }

    this.ideasById.set(sanitized.ideaId, sanitized);
    if (this.knownIdeaOwners.size >= this.maxTombstones) {
      const oldest = this.knownIdeaOwners.keys().next().value;
      if (oldest !== undefined) this.knownIdeaOwners.delete(oldest);
    }
    this.knownIdeaOwners.set(sanitized.ideaId, sanitized.sessionId);
    let list = this.ideasBySession.get(sanitized.sessionId);
    if (!list) {
      if (this.ideasBySession.size >= this.maxSessions) {
        const oldestSession = this.ideasBySession.keys().next().value;
        if (oldestSession !== undefined) {
          const evictedList = this.ideasBySession.get(oldestSession) ?? [];
          for (const ev of evictedList) {
            if (!this.hasRetainedPacketForIdea(ev.ideaId)) {
              this.ideasById.delete(ev.ideaId);
            }
          }
          this.ideasBySession.delete(oldestSession);
        }
      }
      list = [];
      this.ideasBySession.set(sanitized.sessionId, list);
    }
    if (list.length >= this.maxEntriesPerSession) {
      const evicted = list.shift();
      if (evicted && !this.hasRetainedPacketForIdea(evicted.ideaId)) {
        this.ideasById.delete(evicted.ideaId);
      }
    }
    list.push(sanitized);
  }

  getIdea(ideaId: string): WorkbenchIdea | null {
    const validId = validateIdentifier(ideaId, "ideaId");
    const match = this.ideasById.get(validId);
    return match ? this.cloneIdea(match) : null;
  }

  listIdeas(sessionId?: string): WorkbenchIdea[] {
    if (sessionId !== undefined) {
      const cleanSessionId = validateIdentifier(sessionId, "sessionId");
      return (this.ideasBySession.get(cleanSessionId) ?? []).map((i) =>
        this.cloneIdea(i)
      );
    }
    return Array.from(this.ideasById.values()).map((i) => this.cloneIdea(i));
  }

  registerPacket(packet: WorkbenchWorkPacket): void {
    const rawTitle = packet.title.length > 512
      ? packet.title.slice(0, 512)
      : packet.title;
    const rawWorkspace =
      packet.targetWorkspace && packet.targetWorkspace.length > 1000
        ? packet.targetWorkspace.slice(0, 1000)
        : packet.targetWorkspace;
    const rawExcerpt = packet.sourceContext.excerpt.length > 8000
      ? packet.sourceContext.excerpt.slice(0, 8000)
      : packet.sourceContext.excerpt;
    const rawIntent = packet.operatorIntent.length > 8000
      ? packet.operatorIntent.slice(0, 8000)
      : packet.operatorIntent;
    const rawNotes = packet.verifierProvenance.independenceNotes.length > 2000
      ? packet.verifierProvenance.independenceNotes.slice(0, 2000)
      : packet.verifierProvenance.independenceNotes;
    const rawCreated = packet.createdAt.length > 128
      ? packet.createdAt.slice(0, 128)
      : packet.createdAt;
    const trimmedExcerpt = rawExcerpt.replace(/^[\r\n]+|[\r\n\s]+$/g, "");
    const excerpt = trimmedExcerpt.length > 4000
      ? closeDanglingFences(trimmedExcerpt.slice(0, 3950) + "\n...[truncated]")
      : closeDanglingFences(trimmedExcerpt);

    const sanitized: WorkbenchWorkPacket = {
      packetId: validateIdentifier(packet.packetId, "packetId"),
      ideaId: packet.ideaId
        ? validateIdentifier(packet.ideaId, "ideaId")
        : null,
      sessionId: validateIdentifier(packet.sessionId, "sessionId"),
      issueId: packet.issueId
        ? validateIdentifier(packet.issueId, "issueId")
        : null,
      title: rawTitle.trim().slice(0, 256),
      targetWorkspace: rawWorkspace?.trim().slice(0, 500) ?? null,
      sourceContext: {
        sessionId: validateIdentifier(
          packet.sourceContext.sessionId,
          "sessionId",
        ),
        referencedEventId: packet.sourceContext.referencedEventId
          ? validateIdentifier(
            packet.sourceContext.referencedEventId,
            "referencedEventId",
          )
          : null,
        excerpt,
        contextSources: (packet.sourceContext.contextSources ?? [])
          .slice(0, 50)
          .map((s) =>
            (s.length > 1000 ? s.slice(0, 1000) : s).trim().slice(0, 500)
          ),
      },
      operatorIntent: closeDanglingFences(
        rawIntent.replace(/^[\r\n]+|[\r\n\s]+$/g, "").slice(0, 2000),
      ),
      proposedAcceptanceCriteria: (packet.proposedAcceptanceCriteria ?? [])
        .slice(0, 20)
        .map((c) =>
          (c.length > 1000 ? c.slice(0, 1000) : c).trim().slice(0, 500)
        ),
      verifierProvenance: {
        verifierType: packet.verifierProvenance.verifierType,
        independenceNotes: sanitizeSingleLine(rawNotes).slice(0, 1000),
      },
      createdAt: rawCreated.trim().slice(0, 64),
    };

    if (sanitized.sourceContext.sessionId !== sanitized.sessionId) {
      throw new Error(
        "packet sessionId and sourceContext sessionId must match",
      );
    }
    if (sanitized.ideaId) {
      const referencedIdea = this.ideasById.get(sanitized.ideaId);
      if (!referencedIdea) {
        throw new Error(
          `referenced idea "${sanitized.ideaId}" does not exist in registry for session "${sanitized.sessionId}"`,
        );
      }
      if (referencedIdea.sessionId !== sanitized.sessionId) {
        throw new Error(
          `packet idea "${sanitized.ideaId}" belongs to session "${referencedIdea.sessionId}", not packet session "${sanitized.sessionId}"`,
        );
      }
    }

    const knownPacketOwner = this.knownPacketOwners.get(sanitized.packetId);
    if (knownPacketOwner && knownPacketOwner !== sanitized.sessionId) {
      throw new Error(
        `cannot re-register packet "${sanitized.packetId}" under session "${sanitized.sessionId}" because it is already registered under session "${knownPacketOwner}"`,
      );
    }

    const existing = this.packetsById.get(sanitized.packetId);
    if (existing) {
      if (existing.sessionId !== sanitized.sessionId) {
        throw new Error(
          `cannot re-register packet "${sanitized.packetId}" under session "${sanitized.sessionId}" because it is already registered under session "${existing.sessionId}"`,
        );
      }
      const prevList = this.packetsBySession.get(existing.sessionId);
      if (prevList) {
        const idx = prevList.findIndex((p) =>
          p.packetId === sanitized.packetId
        );
        if (idx >= 0) prevList.splice(idx, 1);
      }
    }

    this.packetsById.set(sanitized.packetId, sanitized);
    if (this.knownPacketOwners.size >= this.maxTombstones) {
      const oldest = this.knownPacketOwners.keys().next().value;
      if (oldest !== undefined) this.knownPacketOwners.delete(oldest);
    }
    this.knownPacketOwners.set(sanitized.packetId, sanitized.sessionId);
    let list = this.packetsBySession.get(sanitized.sessionId);
    if (!list) {
      if (this.packetsBySession.size >= this.maxSessions) {
        const oldestSession = this.packetsBySession.keys().next().value;
        if (oldestSession !== undefined) {
          const evictedList = this.packetsBySession.get(oldestSession) ?? [];
          for (const ev of evictedList) {
            this.packetsById.delete(ev.packetId);
            if (ev.ideaId && !this.hasRetainedPacketForIdea(ev.ideaId)) {
              const idea = this.ideasById.get(ev.ideaId);
              if (idea && !this.ideasBySession.has(idea.sessionId)) {
                this.ideasById.delete(ev.ideaId);
              }
            }
          }
          this.packetsBySession.delete(oldestSession);
        }
      }
      list = [];
      this.packetsBySession.set(sanitized.sessionId, list);
    }
    if (list.length >= this.maxEntriesPerSession) {
      const evicted = list.shift();
      if (evicted) {
        this.packetsById.delete(evicted.packetId);
        if (evicted.ideaId && !this.hasRetainedPacketForIdea(evicted.ideaId)) {
          const idea = this.ideasById.get(evicted.ideaId);
          if (idea && !this.ideasBySession.has(idea.sessionId)) {
            this.ideasById.delete(evicted.ideaId);
          }
        }
      }
    }
    list.push(sanitized);
  }

  getPacket(packetId: string): WorkbenchWorkPacket | null {
    const validId = validateIdentifier(packetId, "packetId");
    const match = this.packetsById.get(validId);
    return match ? this.clonePacket(match) : null;
  }

  listPackets(sessionId?: string): WorkbenchWorkPacket[] {
    if (sessionId !== undefined) {
      const cleanSessionId = validateIdentifier(sessionId, "sessionId");
      return (this.packetsBySession.get(cleanSessionId) ?? []).map((p) =>
        this.clonePacket(p)
      );
    }
    return Array.from(this.packetsById.values()).map((p) =>
      this.clonePacket(p)
    );
  }

  clear(): void {
    this.ideasById.clear();
    this.ideasBySession.clear();
    this.packetsById.clear();
    this.packetsBySession.clear();
    this.knownIdeaOwners.clear();
    this.knownPacketOwners.clear();
  }
}

/** The newest event in `events` with this session and event id, scanning at most 10,000 from the end. */
function findSessionEvent(
  events: WorkbenchSessionEvent[],
  sessionId: string,
  eventId: string,
): WorkbenchSessionEvent | undefined {
  const maxScan = Math.min(events.length, 10000);
  for (
    let count = 0, i = events.length - 1;
    i >= 0 && count < maxScan;
    i--, count++
  ) {
    const ev = events[i];
    if (ev.sessionId === sessionId && ev.eventId === eventId) {
      return ev;
    }
  }
  return undefined;
}

/** Up to 50 of this session's events, oldest first, from the last 200 events scanned. */
function recentSessionEvents(
  events: WorkbenchSessionEvent[],
  sessionId: string,
): WorkbenchSessionEvent[] {
  const sessionEvents: WorkbenchSessionEvent[] = [];
  let totalScanned = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    totalScanned++;
    if (totalScanned > 200) break;
    const ev = events[i];
    if (ev.sessionId === sessionId) {
      sessionEvents.unshift(ev);
      if (sessionEvents.length >= 50) break;
    }
  }
  return sessionEvents;
}

/** The source-context excerpt for a packet that references one event. */
function excerptFromEvent(match: WorkbenchSessionEvent): string {
  if (match.content && match.content.length > 0) {
    const preSlice = match.content.length > 4000
      ? match.content.slice(0, 4000)
      : match.content;
    const trimmed = preSlice.trim();
    return match.content.length > 4000
      ? closeDanglingFences(trimmed.slice(0, 3950) + "\n...[truncated]")
      : closeDanglingFences(trimmed);
  }
  if (match.toolName) {
    return `[Tool Call: ${match.toolName}]: ${
      safeBoundedJson(match.toolArguments ?? {})
    }`;
  }
  return `[Event ${match.eventId}]: ${match.eventType}`;
}

/** The last four user and assistant turns, each cut to a short snippet. */
function recentConversationExcerpt(
  sessionEvents: WorkbenchSessionEvent[],
): string {
  const relevant = sessionEvents
    .filter((e) =>
      e.eventType === "session_start" ||
      e.eventType === "model_response" ||
      e.eventType === "agent_response"
    )
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .slice(-4);
  return relevant
    .map((e) => {
      const rawContent = e.content ?? "";
      const preSlice = rawContent.length > 1000
        ? rawContent.slice(0, 1000)
        : rawContent;
      const raw = preSlice.trim();
      const snippet = rawContent.length > 300 || raw.length > 300
        ? closeDanglingFences(raw.slice(0, 300) + "\n...[truncated]")
        : closeDanglingFences(raw);
      return `[${
        e.eventType === "session_start" ? "User" : "Assistant"
      }]: ${snippet}`;
    })
    .join("\n\n");
}

/** The supplied context sources, or else the files this session read recently. */
function packetContextSources(
  supplied: string[] | undefined,
  events: WorkbenchSessionEvent[] | undefined,
  sessionId: string,
): string[] {
  const contextSources: string[] = [];
  if (supplied && supplied.length > 0) {
    contextSources.push(
      ...supplied.slice(0, 50).map((s) =>
        s.length > 1000 ? s.slice(0, 1000) : s
      ),
    );
  } else if (events && events.length > 0) {
    const seen = new Set<string>();
    let totalScanned = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      totalScanned++;
      if (totalScanned > 200) break;
      const ev = events[i];
      if (
        ev.sessionId === sessionId && ev.toolName === "read_file" &&
        ev.toolArguments
      ) {
        const p = String(
          (ev.toolArguments as any).path ||
            (ev.toolArguments as any).filePath || "",
        ).trim();
        if (p.length > 0 && !seen.has(p)) {
          seen.add(p);
          contextSources.push(p.slice(0, 500));
          if (contextSources.length >= 20) break;
        }
      }
    }
  }
  return contextSources;
}

/** The supplied acceptance criteria, or two defaults for the title, sanitized. */
function proposeAcceptanceCriteria(
  supplied: string[] | undefined,
  title: string,
): string[] {
  const rawCriteria = supplied && supplied.length > 0
    ? supplied.slice(0, 20)
    : [
      `Fulfill the objective: "${title}"`,
      `Verify outcomes against operator intent and documented constraints`,
    ];
  return rawCriteria
    .map((c) =>
      sanitizeCriterion(c.length > 1000 ? c.slice(0, 1000) : c).slice(0, 500)
    );
}

export function markWorkbenchIdea(input: {
  sessionId: string;
  label: string;
  eventId?: string | null;
  description?: string;
  events?: WorkbenchSessionEvent[];
  ideaId?: string;
  createdAt?: string;
  registry: IdeaPacketRegistry;
}): WorkbenchIdea {
  const sessionId = validateIdentifier(input.sessionId, "sessionId");
  if (typeof input.label !== "string") {
    throw new Error("label must be a string");
  }
  const rawLabel = input.label.length > 512
    ? input.label.slice(0, 512)
    : input.label;
  const label = sanitizeSingleLine(stripOuterQuotes(rawLabel)).slice(0, 256);
  if (label.length === 0) {
    throw new Error("idea label cannot be empty or whitespace-only");
  }

  const rawDesc = typeof input.description === "string"
    ? (input.description.length > 4000
      ? input.description.slice(0, 4000)
      : input.description).trim().slice(0, 2000)
    : "";
  let description = rawDesc;
  if (input.eventId !== undefined && input.eventId !== null) {
    const eventId = validateIdentifier(input.eventId, "eventId");
    if (input.events === undefined) {
      throw new Error(
        `cannot mark idea with eventId "${eventId}" without supplying session events for session "${sessionId}"`,
      );
    }
    const match = findSessionEvent(input.events, sessionId, eventId);
    if (!match) {
      throw new Error(
        `event "${eventId}" not found in session events for session "${sessionId}"`,
      );
    }
    if (description.length === 0 && match.content) {
      description = match.content.slice(0, 4000).trim().slice(0, 2000);
    }
  } else if (
    description.length === 0 && input.events && input.events.length > 0
  ) {
    const candidates = recentSessionEvents(input.events, sessionId)
      .filter((e) =>
        (e.eventType === "model_response" ||
          e.eventType === "agent_response" ||
          e.eventType === "session_start") &&
        e.content
      )
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    if (candidates.length > 0) {
      description = (candidates[candidates.length - 1].content ?? "")
        .slice(0, 4000)
        .trim()
        .slice(0, 2000);
    }
  }

  if (description.length === 0) {
    description = label;
  }
  description = description.replace(/[\u0000-\u001F\u007F-\u009F\u001B]/g, " ")
    .trim().slice(0, 2000);

  const idea: WorkbenchIdea = {
    ideaId: input.ideaId
      ? validateIdentifier(input.ideaId, "ideaId")
      : generateULID(),
    sessionId,
    eventId: input.eventId
      ? validateIdentifier(input.eventId, "eventId")
      : null,
    label,
    description,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  const reg = input.registry;
  reg.registerIdea(idea);
  return reg.getIdea(idea.ideaId)!;
}

export function draftWorkPacketFromContext(input: {
  sessionId: string;
  idea?: WorkbenchIdea | null;
  ideaId?: string;
  eventId?: string | null;
  issueId?: string | null;
  title?: string;
  operatorIntent?: string;
  workspace?: string | null;
  contextSources?: string[];
  acceptanceCriteria?: string[];
  events?: WorkbenchSessionEvent[];
  createdAt?: string;
  packetId?: string;
  registry: IdeaPacketRegistry;
}): WorkbenchWorkPacket {
  const sessionId = validateIdentifier(input.sessionId, "sessionId");
  const reg = input.registry;

  let idea = input.idea;
  if (!idea && input.ideaId) {
    const cleanIdeaId = validateIdentifier(input.ideaId, "ideaId");
    idea = reg.getIdea(cleanIdeaId);
    if (!idea) {
      throw new Error(
        `idea "${cleanIdeaId}" not found for session "${sessionId}"`,
      );
    }
  }

  let referencedEventId = input.eventId
    ? validateIdentifier(input.eventId, "eventId")
    : (idea?.eventId ? validateIdentifier(idea.eventId, "eventId") : null);
  let excerpt = "";
  let operatorIntent = "";
  let title = (input.title?.slice(0, 1000).trim() || "").slice(0, 256);

  if (idea) {
    if (idea.sessionId !== sessionId) {
      throw new Error(
        `idea "${idea.ideaId}" belongs to session "${idea.sessionId}", not requested session "${sessionId}"`,
      );
    }
    if (!title) {
      title = idea.label;
    }
    operatorIntent = idea.description || idea.label;
  }

  if (referencedEventId) {
    if (input.eventId && (!input.events || input.events.length === 0)) {
      throw new Error(
        `cannot draft packet with referenced event "${referencedEventId}" without supplying session events for session "${sessionId}"`,
      );
    }
    const match = input.events && input.events.length > 0
      ? findSessionEvent(input.events, sessionId, referencedEventId)
      : undefined;
    if (!match) {
      if (input.eventId) {
        throw new Error(
          `referenced event "${referencedEventId}" not found in session events for session "${sessionId}"`,
        );
      }
      referencedEventId = null;
      if (idea) {
        excerpt = (idea.description || idea.label).slice(0, 4000);
      }
    } else {
      excerpt = excerptFromEvent(match);
      if (match.content && match.content.length > 0 && !operatorIntent) {
        operatorIntent = match.content.slice(0, 4000).trim().slice(0, 2000);
      }
      if (!title) {
        title = match.eventType ?? `Event ${referencedEventId}`;
      }
    }
  }

  if (!excerpt) {
    excerpt = recentConversationExcerpt(
      recentSessionEvents(input.events ?? [], sessionId),
    );
  }

  if (input.operatorIntent) {
    operatorIntent = input.operatorIntent.slice(0, 4000).replace(
      /^[\r\n]+|[\r\n\s]+$/g,
      "",
    ).slice(0, 2000);
  }

  const cleanTitle = sanitizeSingleLine(stripOuterQuotes(title));
  title = cleanTitle ||
    (operatorIntent
      ? sanitizeSingleLine(stripOuterQuotes(operatorIntent)).slice(0, 60)
      : "") ||
    "Draft Work Packet";

  if (!operatorIntent) {
    operatorIntent = title;
  }

  const contextSources = packetContextSources(
    input.contextSources,
    input.events,
    sessionId,
  );
  const proposedAcceptanceCriteria = proposeAcceptanceCriteria(
    input.acceptanceCriteria,
    title,
  );

  const packet: WorkbenchWorkPacket = {
    packetId: input.packetId
      ? validateIdentifier(input.packetId, "packetId")
      : generateULID(),
    ideaId: idea ? idea.ideaId : null,
    sessionId,
    issueId: input.issueId
      ? validateIdentifier(input.issueId, "issueId")
      : null,
    title: title.slice(0, 256),
    targetWorkspace: input.workspace
      ? input.workspace.trim().slice(0, 1024)
      : null,
    sourceContext: {
      sessionId,
      referencedEventId,
      excerpt,
      contextSources,
    },
    operatorIntent,
    proposedAcceptanceCriteria,
    verifierProvenance: {
      verifierType: "human_operator",
      independenceNotes:
        "Verifier evaluation must be independent of generation. Machine and model assertions serve as evidence, not self-certifying truth.",
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  reg.registerPacket(packet);
  return reg.getPacket(packet.packetId)!;
}
