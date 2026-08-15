// Idea marking and Work Packet drafting domain model for Workbench.
// Enriches candidate ideas and draft work packets with supplied session context.

import { generateULID } from "./utils";
import type { WorkbenchSessionEvent } from "./sessions";

export interface WorkbenchIdea {
  ideaId: string;
  sessionId: string;
  eventId: string | null;
  label: string;
  description: string;
  createdAt: string;
}

export interface WorkbenchWorkPacketSourceContext {
  sessionId: string;
  referencedEventId: string | null;
  excerpt: string;
  contextSources: string[];
}

export interface WorkbenchWorkPacketVerifierProvenance {
  verifierType: "human_operator" | "automated_test" | "model_eval";
  independenceNotes: string;
}

export interface WorkbenchWorkPacket {
  packetId: string;
  ideaId: string | null;
  sessionId: string;
  issueId: string | null;
  title: string;
  targetWorkspace: string | null;
  sourceContext: WorkbenchWorkPacketSourceContext;
  operatorIntent: string;
  proposedAcceptanceCriteria: string[];
  verifierProvenance: WorkbenchWorkPacketVerifierProvenance;
  createdAt: string;
}

function validateIdentifier(id: string, fieldName = "identifier"): string {
  if (typeof id !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (id.length > 512) {
    throw new Error(`${fieldName} exceeds maximum length of 256 characters`);
  }
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (trimmed.length > 256) {
    throw new Error(`${fieldName} exceeds maximum length of 256 characters`);
  }
  return trimmed;
}

function boundedCloneForJson(val: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    return val.length > 500 ? val.slice(0, 500) + "...[truncated]" : val;
  }
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item) => boundedCloneForJson(item, depth + 1));
  }
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const k in (val as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(val, k)) {
        out[k.slice(0, 100)] = boundedCloneForJson(
          (val as Record<string, unknown>)[k],
          depth + 1,
        );
        count++;
        if (count >= 20) break;
      }
    }
    return out;
  }
  return String(val).slice(0, 100);
}

function safeBoundedJson(obj: unknown, maxLen = 4000): string {
  if (obj === null || obj === undefined) return "{}";
  try {
    const bounded = boundedCloneForJson(obj);
    const str = JSON.stringify(bounded);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + "...[truncated]";
  } catch {
    return "[unserializable arguments]";
  }
}

function sanitizeMarkdownHeading(text: string): string {
  return text
    .replace(
      /^((?:[ \t]*(?:>[ \t]*|[*+-][ \t]+|\d+[.)][ \t]+))*[ \t]*)(#+)/gm,
      (_match, prefix, hashes) => `${prefix}\\${hashes}`,
    )
    .replace(
      /^((?:[ \t]*(?:>[ \t]*|[*+-][ \t]+|\d+[.)][ \t]+))*[ \t]*)([=-]{2,}[ \t]*)$/gm,
      (_match, prefix, underline) => `${prefix}\\${underline}`,
    )
    .replace(
      /^((?:[ \t]*(?:>[ \t]*|[*+-][ \t]+|\d+[.)][ \t]+))*[ \t]*)(<[hH][1-6])/gm,
      (_match, prefix, tag) => `${prefix}\\${tag}`,
    );
}

function sanitizeSingleLine(text: string): string {
  return text.replace(/[\r\n]/g, " ").trim();
}

export class IdeaPacketRegistry {
  private readonly ideasById = new Map<string, WorkbenchIdea>();
  private readonly ideasBySession = new Map<string, WorkbenchIdea[]>();
  private readonly packetsById = new Map<string, WorkbenchWorkPacket>();
  private readonly packetsBySession = new Map<string, WorkbenchWorkPacket[]>();
  private readonly maxSessions = 100;
  private readonly maxEntriesPerSession = 50;

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
    const rawLabel = idea.label.length > 512 ? idea.label.slice(0, 512) : idea.label;
    const rawDesc = idea.description.length > 4000 ? idea.description.slice(0, 4000) : idea.description;
    const rawCreated = idea.createdAt.length > 128 ? idea.createdAt.slice(0, 128) : idea.createdAt;
    const sanitized: WorkbenchIdea = {
      ideaId: validateIdentifier(idea.ideaId, "ideaId"),
      sessionId: validateIdentifier(idea.sessionId, "sessionId"),
      eventId: idea.eventId ? validateIdentifier(idea.eventId, "eventId") : null,
      label: rawLabel.trim().slice(0, 256),
      description: rawDesc.trim().slice(0, 2000),
      createdAt: rawCreated.trim().slice(0, 64),
    };

    const existing = this.ideasById.get(sanitized.ideaId);
    if (existing) {
      const prevList = this.ideasBySession.get(existing.sessionId);
      if (prevList) {
        const idx = prevList.findIndex((i) => i.ideaId === sanitized.ideaId);
        if (idx >= 0) prevList.splice(idx, 1);
        if (prevList.length === 0 && existing.sessionId !== sanitized.sessionId) {
          this.ideasBySession.delete(existing.sessionId);
        }
      }
    }

    this.ideasById.set(sanitized.ideaId, sanitized);
    let list = this.ideasBySession.get(sanitized.sessionId);
    if (!list) {
      if (this.ideasBySession.size >= this.maxSessions) {
        const oldestSession = this.ideasBySession.keys().next().value;
        if (oldestSession !== undefined) {
          const evictedList = this.ideasBySession.get(oldestSession) ?? [];
          for (const ev of evictedList) this.ideasById.delete(ev.ideaId);
          this.ideasBySession.delete(oldestSession);
        }
      }
      list = [];
      this.ideasBySession.set(sanitized.sessionId, list);
    }
    if (list.length >= this.maxEntriesPerSession) {
      const evicted = list.shift();
      if (evicted) this.ideasById.delete(evicted.ideaId);
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
    const rawTitle = packet.title.length > 512 ? packet.title.slice(0, 512) : packet.title;
    const rawWorkspace = packet.targetWorkspace && packet.targetWorkspace.length > 1000
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
    const rawCreated = packet.createdAt.length > 128 ? packet.createdAt.slice(0, 128) : packet.createdAt;

    const sanitized: WorkbenchWorkPacket = {
      packetId: validateIdentifier(packet.packetId, "packetId"),
      ideaId: packet.ideaId ? validateIdentifier(packet.ideaId, "ideaId") : null,
      sessionId: validateIdentifier(packet.sessionId, "sessionId"),
      issueId: packet.issueId ? validateIdentifier(packet.issueId, "issueId") : null,
      title: rawTitle.trim().slice(0, 256),
      targetWorkspace: rawWorkspace?.trim().slice(0, 500) ?? null,
      sourceContext: {
        sessionId: validateIdentifier(packet.sourceContext.sessionId, "sessionId"),
        referencedEventId: packet.sourceContext.referencedEventId
          ? validateIdentifier(
            packet.sourceContext.referencedEventId,
            "referencedEventId",
          )
          : null,
        excerpt: rawExcerpt.trim().slice(0, 4000),
        contextSources: (packet.sourceContext.contextSources ?? [])
          .slice(0, 50)
          .map((s) => (s.length > 1000 ? s.slice(0, 1000) : s).trim().slice(0, 500)),
      },
      operatorIntent: rawIntent.trim().slice(0, 2000),
      proposedAcceptanceCriteria: (packet.proposedAcceptanceCriteria ?? [])
        .slice(0, 20)
        .map((c) => (c.length > 1000 ? c.slice(0, 1000) : c).trim().slice(0, 500)),
      verifierProvenance: {
        verifierType: packet.verifierProvenance.verifierType,
        independenceNotes: rawNotes.trim().slice(0, 1000),
      },
      createdAt: rawCreated.trim().slice(0, 64),
    };

    const existing = this.packetsById.get(sanitized.packetId);
    if (existing) {
      const prevList = this.packetsBySession.get(existing.sessionId);
      if (prevList) {
        const idx = prevList.findIndex((p) => p.packetId === sanitized.packetId);
        if (idx >= 0) prevList.splice(idx, 1);
        if (prevList.length === 0 && existing.sessionId !== sanitized.sessionId) {
          this.packetsBySession.delete(existing.sessionId);
        }
      }
    }

    this.packetsById.set(sanitized.packetId, sanitized);
    let list = this.packetsBySession.get(sanitized.sessionId);
    if (!list) {
      if (this.packetsBySession.size >= this.maxSessions) {
        const oldestSession = this.packetsBySession.keys().next().value;
        if (oldestSession !== undefined) {
          const evictedList = this.packetsBySession.get(oldestSession) ?? [];
          for (const ev of evictedList) this.packetsById.delete(ev.packetId);
          this.packetsBySession.delete(oldestSession);
        }
      }
      list = [];
      this.packetsBySession.set(sanitized.sessionId, list);
    }
    if (list.length >= this.maxEntriesPerSession) {
      const evicted = list.shift();
      if (evicted) this.packetsById.delete(evicted.packetId);
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
  }
}

export const defaultIdeaPacketRegistry = new IdeaPacketRegistry();

export function listWorkbenchIdeas(options?: {
  sessionId?: string;
  registry?: IdeaPacketRegistry;
}): WorkbenchIdea[] {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.listIdeas(options?.sessionId);
}

export function getWorkbenchIdea(
  ideaId: string,
  options?: { registry?: IdeaPacketRegistry },
): WorkbenchIdea | null {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.getIdea(ideaId);
}

export function listWorkbenchPackets(options?: {
  sessionId?: string;
  registry?: IdeaPacketRegistry;
}): WorkbenchWorkPacket[] {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.listPackets(options?.sessionId);
}

export function getWorkbenchPacket(
  packetId: string,
  options?: { registry?: IdeaPacketRegistry },
): WorkbenchWorkPacket | null {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.getPacket(packetId);
}

export function markWorkbenchIdea(input: {
  sessionId: string;
  label: string;
  eventId?: string | null;
  description?: string;
  events?: WorkbenchSessionEvent[];
  ideaId?: string;
  createdAt?: string;
  registry?: IdeaPacketRegistry;
}): WorkbenchIdea {
  const sessionId = validateIdentifier(input.sessionId, "sessionId");
  if (typeof input.label !== "string") {
    throw new Error("label must be a string");
  }
  const rawLabel = input.label.length > 512 ? input.label.slice(0, 512) : input.label;
  const label = rawLabel.trim().slice(0, 256);
  if (label.length === 0) {
    throw new Error("idea label cannot be empty");
  }

  const rawDesc = typeof input.description === "string"
    ? (input.description.length > 4000 ? input.description.slice(0, 4000) : input.description).trim().slice(0, 2000)
    : "";
  let description = rawDesc;
  if (input.eventId !== undefined && input.eventId !== null) {
    const eventId = validateIdentifier(input.eventId, "eventId");
    if (input.events !== undefined) {
      const match = input.events.find((e) => e.eventId === eventId);
      if (!match) {
        throw new Error(`event "${eventId}" not found in session events`);
      }
      if (description.length === 0 && match.content) {
        description = match.content.slice(0, 4000).trim().slice(0, 2000);
      }
    }
  } else if (description.length === 0 && input.events && input.events.length > 0) {
    const recent = input.events.slice(-50);
    const candidates = recent
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

  const idea: WorkbenchIdea = {
    ideaId: input.ideaId
      ? validateIdentifier(input.ideaId, "ideaId")
      : generateULID(),
    sessionId,
    eventId: input.eventId ? validateIdentifier(input.eventId, "eventId") : null,
    label,
    description,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  const reg = input.registry ?? defaultIdeaPacketRegistry;
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
  acceptanceCriteria?: string[];
  events?: WorkbenchSessionEvent[];
  workspace?: string | null;
  packetId?: string;
  createdAt?: string;
  registry?: IdeaPacketRegistry;
}): WorkbenchWorkPacket {
  const reg = input.registry ?? defaultIdeaPacketRegistry;
  const sessionId = validateIdentifier(input.sessionId, "sessionId");
  let idea: WorkbenchIdea | null = null;
  if (input.idea) {
    idea = input.idea;
  } else if (input.ideaId) {
    idea = reg.getIdea(input.ideaId);
    if (!idea) {
      throw new Error(`idea "${input.ideaId}" not found`);
    }
  }

  if (idea && idea.sessionId !== sessionId) {
    throw new Error(
      `idea "${idea.ideaId}" belongs to session "${idea.sessionId}", not requested session "${sessionId}"`,
    );
  }

  const rawTitle = typeof input.title === "string"
    ? (input.title.length > 512 ? input.title.slice(0, 512) : input.title).trim().slice(0, 256)
    : (idea?.label || "Draft Work Packet");
  const title = rawTitle.length > 0 ? rawTitle : "Draft Work Packet";

  const rawIntent = typeof input.operatorIntent === "string"
    ? (input.operatorIntent.length > 8000 ? input.operatorIntent.slice(0, 8000) : input.operatorIntent).trim().slice(0, 2000)
    : (idea?.description || idea?.label || title);
  const operatorIntent = rawIntent.length > 0 ? rawIntent : title;

  let referencedEventId = input.eventId
    ? validateIdentifier(input.eventId, "eventId")
    : (idea?.eventId ? validateIdentifier(idea.eventId, "eventId") : null);
  let excerpt = "";
  const contextSources: string[] = [];

  const events = input.events;
  if (referencedEventId) {
    if (events !== undefined) {
      const match = events.find((e) => e.eventId === referencedEventId);
      if (!match) {
        throw new Error(
          `referenced event "${referencedEventId}" not found in session events`,
        );
      }
      if (match.content && match.content.length > 0) {
        const raw = match.content.slice(0, 8000).trim();
        excerpt = raw.length > 4000
          ? raw.slice(0, 4000) + "...[truncated]"
          : raw;
      } else if (match.toolName) {
        excerpt = `[Tool Call: ${match.toolName}]: ${
          safeBoundedJson(match.toolArguments ?? {})
        }`;
      } else {
        excerpt = `[Event ${match.eventId}]: ${match.eventType}`;
      }
    }
  } else if (events && events.length > 0) {
    const recent = events.slice(-50);
    const relevant = recent
      .filter((e) =>
        e.eventType === "session_start" ||
        e.eventType === "model_response" ||
        e.eventType === "agent_response"
      )
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
      .slice(-4);
    excerpt = relevant
      .map((e) =>
        `[${e.eventType === "session_start" ? "User" : "Assistant"}]: ${
          (e.content ?? "").slice(0, 600).trim().slice(0, 300)
        }`
      )
      .join("\n\n");
    if (relevant.length > 0 && !referencedEventId) {
      referencedEventId = relevant[relevant.length - 1].eventId;
    }
  }

  if (excerpt.length === 0) {
    excerpt = (idea?.description || operatorIntent).slice(0, 4000);
  }

  const recentEvents = events ? events.slice(-20) : [];
  for (const ev of recentEvents) {
    if (ev.toolName === "read_file" && ev.toolArguments?.path) {
      const p = String(ev.toolArguments.path).trim().slice(0, 500);
      if (!contextSources.includes(p) && contextSources.length < 50) {
        contextSources.push(p);
      }
    }
  }

  const rawCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.slice(0, 20)
      : [
        `Fulfill the objective: "${title}"`,
        `Verify outcomes against operator intent and documented constraints`,
      ];
  const proposedAcceptanceCriteria = rawCriteria
    .map((c) => sanitizeSingleLine(c).slice(0, 500));

  const packet: WorkbenchWorkPacket = {
    packetId: input.packetId
      ? validateIdentifier(input.packetId, "packetId")
      : generateULID(),
    ideaId: idea?.ideaId ?? (input.ideaId ? validateIdentifier(input.ideaId, "ideaId") : null),
    sessionId,
    issueId: input.issueId ? validateIdentifier(input.issueId, "issueId") : null,
    title: sanitizeSingleLine(title),
    targetWorkspace: input.workspace ?? null,
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

function escapeCodeSpan(str: string): string {
  return sanitizeSingleLine(str).replace(/[`<>]/g, "");
}

export function formatWorkPacketMarkdown(packet: WorkbenchWorkPacket): string {
  const safeTitle = sanitizeMarkdownHeading(sanitizeSingleLine(packet.title));
  const safeSession = escapeCodeSpan(packet.sessionId);
  const safePacketId = escapeCodeSpan(packet.packetId);
  const safeDate = escapeCodeSpan(packet.createdAt.split("T")[0]);
  const safeIssue = packet.issueId
    ? `\`${escapeCodeSpan(packet.issueId)}\``
    : "none";
  const safeWorkspace = packet.targetWorkspace
    ? `\`${escapeCodeSpan(packet.targetWorkspace)}\``
    : "(current workspace)";
  const safeExcerpt = sanitizeMarkdownHeading(packet.sourceContext.excerpt);
  const safeIntent = sanitizeMarkdownHeading(packet.operatorIntent);

  const lines: string[] = [
    `# Work Packet: ${safeTitle}`,
    "",
    `- **Packet ID:** \`${safePacketId}\``,
    `- **Date:** ${safeDate}`,
    `- **Session:** \`${safeSession}\``,
    `- **Related Issue:** ${safeIssue}`,
    `- **Target Workspace:** ${safeWorkspace}`,
    "",
    "## 1. Source Context",
    "",
    safeExcerpt,
    "",
  ];

  if (
    packet.sourceContext.contextSources &&
    packet.sourceContext.contextSources.length > 0
  ) {
    lines.push("### Context Files", "");
    for (const src of packet.sourceContext.contextSources) {
      const safePath = escapeCodeSpan(src);
      lines.push(`- \`${safePath}\``);
    }
    lines.push("");
  }

  lines.push(
    "## 2. Operator Intent",
    "",
    safeIntent,
    "",
    "## 3. Proposed Acceptance Criteria",
    "",
  );

  for (const criterion of packet.proposedAcceptanceCriteria) {
    const safeCriterion = sanitizeSingleLine(criterion);
    lines.push(`- [ ] ${safeCriterion}`);
  }

  lines.push(
    "",
    "## 4. Verification & Provenance",
    "",
    `- **Primary Verifier:** \`${escapeCodeSpan(packet.verifierProvenance.verifierType)}\``,
    `- **Independence & Oracle Policy:** ${
      sanitizeSingleLine(packet.verifierProvenance.independenceNotes)
    }`,
    "",
  );

  return lines.join("\n");
}
