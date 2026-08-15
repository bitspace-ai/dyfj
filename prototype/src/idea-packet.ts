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

export class IdeaPacketRegistry {
  private readonly ideasById = new Map<string, WorkbenchIdea>();
  private readonly ideasBySession = new Map<string, WorkbenchIdea[]>();
  private readonly packetsById = new Map<string, WorkbenchWorkPacket>();
  private readonly packetsBySession = new Map<string, WorkbenchWorkPacket[]>();
  private readonly maxSessions = 100;
  private readonly maxEntriesPerSession = 50;

  registerIdea(idea: WorkbenchIdea): void {
    const sanitized: WorkbenchIdea = {
      ideaId: idea.ideaId.trim().slice(0, 64),
      sessionId: idea.sessionId.trim().slice(0, 64),
      eventId: idea.eventId?.trim().slice(0, 64) ?? null,
      label: idea.label.trim().slice(0, 256),
      description: idea.description.trim().slice(0, 2000),
      createdAt: idea.createdAt.trim().slice(0, 64),
    };
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
    return this.ideasById.get(ideaId) ?? null;
  }

  listIdeas(sessionId?: string): WorkbenchIdea[] {
    if (sessionId !== undefined) {
      return [...(this.ideasBySession.get(sessionId) ?? [])];
    }
    return Array.from(this.ideasById.values());
  }

  registerPacket(packet: WorkbenchWorkPacket): void {
    const sanitized: WorkbenchWorkPacket = {
      packetId: packet.packetId.trim().slice(0, 64),
      ideaId: packet.ideaId?.trim().slice(0, 64) ?? null,
      sessionId: packet.sessionId.trim().slice(0, 64),
      issueId: packet.issueId?.trim().slice(0, 64) ?? null,
      title: packet.title.trim().slice(0, 256),
      targetWorkspace: packet.targetWorkspace?.trim().slice(0, 500) ?? null,
      sourceContext: {
        sessionId: packet.sourceContext.sessionId.trim().slice(0, 64),
        referencedEventId:
          packet.sourceContext.referencedEventId?.trim().slice(0, 64) ?? null,
        excerpt: packet.sourceContext.excerpt.trim().slice(0, 4000),
        contextSources: (packet.sourceContext.contextSources ?? [])
          .slice(0, 50)
          .map((s) => s.trim().slice(0, 500)),
      },
      operatorIntent: packet.operatorIntent.trim().slice(0, 2000),
      proposedAcceptanceCriteria: (packet.proposedAcceptanceCriteria ?? [])
        .slice(0, 20)
        .map((c) => c.trim().slice(0, 500)),
      verifierProvenance: {
        verifierType: packet.verifierProvenance.verifierType,
        independenceNotes: packet.verifierProvenance.independenceNotes
          .trim()
          .slice(0, 1000),
      },
      createdAt: packet.createdAt.trim().slice(0, 64),
    };
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
    return this.packetsById.get(packetId) ?? null;
  }

  listPackets(sessionId?: string): WorkbenchWorkPacket[] {
    if (sessionId !== undefined) {
      return [...(this.packetsBySession.get(sessionId) ?? [])];
    }
    return Array.from(this.packetsById.values());
  }

  clear(): void {
    this.ideasById.clear();
    this.ideasBySession.clear();
    this.packetsById.clear();
    this.packetsBySession.clear();
  }
}

export const defaultIdeaPacketRegistry = new IdeaPacketRegistry();

export function listWorkbenchIdeas(
  options?: { sessionId?: string; registry?: IdeaPacketRegistry },
): WorkbenchIdea[] {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.listIdeas(options?.sessionId);
}

export function getWorkbenchIdea(
  ideaId: string,
  registry?: IdeaPacketRegistry,
): WorkbenchIdea | null {
  const reg = registry ?? defaultIdeaPacketRegistry;
  return reg.getIdea(ideaId);
}

export function listWorkbenchPackets(
  options?: { sessionId?: string; registry?: IdeaPacketRegistry },
): WorkbenchWorkPacket[] {
  const reg = options?.registry ?? defaultIdeaPacketRegistry;
  return reg.listPackets(options?.sessionId);
}

export function getWorkbenchPacket(
  packetId: string,
  registry?: IdeaPacketRegistry,
): WorkbenchWorkPacket | null {
  const reg = registry ?? defaultIdeaPacketRegistry;
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
  const label = input.label.trim().slice(0, 256);
  if (label.length === 0) {
    throw new Error("idea label cannot be empty");
  }

  let description = input.description?.trim().slice(0, 2000) ?? "";
  if (input.eventId !== undefined && input.eventId !== null) {
    if (input.events !== undefined) {
      const match = input.events.find((e) => e.eventId === input.eventId);
      if (!match) {
        throw new Error(`event "${input.eventId}" not found in session events`);
      }
      if (description.length === 0 && match.content) {
        description = match.content.trim().slice(0, 2000);
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
        .trim()
        .slice(0, 2000);
    }
  }

  if (description.length === 0) {
    description = label;
  }

  const idea: WorkbenchIdea = {
    ideaId: input.ideaId ?? generateULID(),
    sessionId: input.sessionId,
    eventId: input.eventId ?? null,
    label,
    description,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  const reg = input.registry ?? defaultIdeaPacketRegistry;
  reg.registerIdea(idea);
  return idea;
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
  let idea: WorkbenchIdea | null = null;
  if (input.idea) {
    idea = input.idea;
  } else if (input.ideaId) {
    idea = reg.getIdea(input.ideaId);
    if (!idea) {
      throw new Error(`idea "${input.ideaId}" not found`);
    }
  }

  if (idea && idea.sessionId !== input.sessionId) {
    throw new Error(
      `idea "${idea.ideaId}" belongs to session "${idea.sessionId}", not requested session "${input.sessionId}"`,
    );
  }

  const title = (input.title?.trim() || idea?.label || "Draft Work Packet")
    .slice(0, 256);

  const operatorIntent = (input.operatorIntent?.trim() || idea?.label || title)
    .slice(0, 2000);

  let referencedEventId = input.eventId ?? idea?.eventId ?? null;
  let excerpt = "";
  const contextSources: string[] = [];

  if (input.events !== undefined) {
    if (referencedEventId) {
      const match = input.events.find((e) => e.eventId === referencedEventId);
      if (!match) {
        throw new Error(
          `referenced event "${referencedEventId}" not found in session events`,
        );
      }
      if (match.content) {
        excerpt = match.content.trim().slice(0, 4000);
      }
    }
    if (excerpt.length === 0 && input.events.length > 0) {
      const recent = input.events.slice(-50);
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
            (e.content ?? "").slice(0, 300)
          }`
        )
        .join("\n\n");
      if (relevant.length > 0 && !referencedEventId) {
        referencedEventId = relevant[relevant.length - 1].eventId;
      }
    }

    const recentEvents = input.events.slice(-20);
    for (const ev of recentEvents) {
      if (ev.toolName === "read_file" && ev.toolArguments?.path) {
        const p = String(ev.toolArguments.path).trim().slice(0, 500);
        if (!contextSources.includes(p) && contextSources.length < 50) {
          contextSources.push(p);
        }
      }
    }
  }

  if (excerpt.length === 0) {
    excerpt = (idea?.description || operatorIntent).slice(0, 4000);
  }
  if (excerpt.length > 4000) {
    excerpt = excerpt.slice(0, 4000) + "\n...[truncated]";
  }

  const rawCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.slice(0, 20)
      : [
        `Fulfill the objective: "${title}"`,
        `Verify outcomes against operator intent and documented constraints`,
      ];
  const proposedAcceptanceCriteria = rawCriteria
    .map((c) => c.trim().slice(0, 500));

  const packet: WorkbenchWorkPacket = {
    packetId: input.packetId ?? generateULID(),
    ideaId: idea?.ideaId ?? input.ideaId ?? null,
    sessionId: input.sessionId,
    issueId: input.issueId?.trim().slice(0, 64) || null,
    title,
    targetWorkspace: input.workspace ?? null,
    sourceContext: {
      sessionId: input.sessionId,
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
  return packet;
}

export function formatWorkPacketMarkdown(packet: WorkbenchWorkPacket): string {
  const lines: string[] = [
    `# Work Packet: ${packet.title}`,
    "",
    `- **Packet ID:** \`${packet.packetId}\``,
    `- **Date:** ${packet.createdAt.split("T")[0]}`,
    `- **Session:** \`${packet.sessionId}\``,
    `- **Related Issue:** ${packet.issueId ? `\`${packet.issueId}\`` : "none"}`,
    `- **Target Workspace:** ${
      packet.targetWorkspace ? `\`${packet.targetWorkspace}\`` : "(current workspace)"
    }`,
    "",
    "## 1. Source Context",
    "",
    packet.sourceContext.excerpt,
    "",
  ];

  if (
    packet.sourceContext.contextSources &&
    packet.sourceContext.contextSources.length > 0
  ) {
    lines.push("### Context Files", "");
    for (const src of packet.sourceContext.contextSources) {
      const safePath = src.replace(/[`\r\n]/g, "");
      lines.push(`- \`${safePath}\``);
    }
    lines.push("");
  }

  lines.push(
    "## 2. Operator Intent",
    "",
    packet.operatorIntent,
    "",
    "## 3. Proposed Acceptance Criteria",
    "",
  );

  for (const criterion of packet.proposedAcceptanceCriteria) {
    lines.push(`- [ ] ${criterion}`);
  }

  lines.push(
    "",
    "## 4. Verification & Provenance",
    "",
    `- **Primary Verifier:** \`${packet.verifierProvenance.verifierType}\``,
    `- **Independence & Oracle Policy:** ${packet.verifierProvenance.independenceNotes}`,
    "",
  );

  return lines.join("\n");
}
