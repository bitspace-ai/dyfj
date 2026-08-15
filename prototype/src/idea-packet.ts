// Idea marking and Work Packet drafting domain model for Workbench.
// Implements Milestone 3 / Packet 0 (BIT-258): purpose-neutral session capture,
// idea marking from conversational turns, and draft work packet generation.

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
  private readonly ideas = new Map<string, WorkbenchIdea>();
  private readonly packets = new Map<string, WorkbenchWorkPacket>();

  registerIdea(idea: WorkbenchIdea): void {
    this.ideas.set(idea.ideaId, idea);
  }

  getIdea(ideaId: string): WorkbenchIdea | null {
    return this.ideas.get(ideaId) ?? null;
  }

  listIdeas(sessionId?: string): WorkbenchIdea[] {
    const all = Array.from(this.ideas.values());
    if (sessionId === undefined) return all;
    return all.filter((i) => i.sessionId === sessionId);
  }

  registerPacket(packet: WorkbenchWorkPacket): void {
    this.packets.set(packet.packetId, packet);
  }

  getPacket(packetId: string): WorkbenchWorkPacket | null {
    return this.packets.get(packetId) ?? null;
  }

  listPackets(sessionId?: string): WorkbenchWorkPacket[] {
    const all = Array.from(this.packets.values());
    if (sessionId === undefined) return all;
    return all.filter((p) => p.sessionId === sessionId);
  }

  clear(): void {
    this.ideas.clear();
    this.packets.clear();
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
  const label = input.label.trim();
  if (label.length === 0) {
    throw new Error("idea label cannot be empty");
  }

  let description = input.description?.trim() ?? "";
  if (description.length === 0 && input.events && input.events.length > 0) {
    if (input.eventId) {
      const match = input.events.find((e) => e.eventId === input.eventId);
      if (match && match.content) {
        description = match.content.trim().slice(0, 1000);
      }
    }
    if (description.length === 0) {
      // Find the latest response or start event
      for (let i = input.events.length - 1; i >= 0; i--) {
        const ev = input.events[i];
        if (
          (ev.eventType === "model_response" ||
            ev.eventType === "agent_response" ||
            ev.eventType === "session_start") &&
          ev.content
        ) {
          description = ev.content.trim().slice(0, 1000);
          break;
        }
      }
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
  const idea = input.idea ??
    (input.ideaId ? reg.getIdea(input.ideaId) : null);

  const title = input.title?.trim() ||
    idea?.label ||
    "Draft Work Packet";

  const operatorIntent = input.operatorIntent?.trim() ||
    idea?.description ||
    title;

  let referencedEventId = input.eventId ?? idea?.eventId ?? null;
  let excerpt = "";
  const contextSources: string[] = [];

  if (input.events && input.events.length > 0) {
    if (referencedEventId) {
      const match = input.events.find((e) => e.eventId === referencedEventId);
      if (match && match.content) {
        excerpt = match.content.trim();
      }
    }
    if (excerpt.length === 0) {
      // Collect recent conversation summary
      const relevant = input.events.filter((e) =>
        e.eventType === "session_start" ||
        e.eventType === "model_response" ||
        e.eventType === "agent_response"
      ).slice(-4);
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

    // Extract any mentioned files
    for (const ev of input.events) {
      if (ev.toolName === "read_file" && ev.toolArguments?.path) {
        const p = String(ev.toolArguments.path);
        if (!contextSources.includes(p)) contextSources.push(p);
      }
    }
  }

  if (excerpt.length === 0) {
    excerpt = idea?.description || operatorIntent;
  }

  const proposedAcceptanceCriteria: string[] = [];
  if (
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
  ) {
    proposedAcceptanceCriteria.push(...input.acceptanceCriteria);
  } else {
    proposedAcceptanceCriteria.push(
      `Implement core capability for "${title}" without regressing existing test suite`,
      `Add automated test coverage validating expected behavior and error cases`,
      `Verify changes against operator acceptance criteria and run publish gate`,
    );
  }

  const packet: WorkbenchWorkPacket = {
    packetId: input.packetId ?? generateULID(),
    ideaId: idea?.ideaId ?? input.ideaId ?? null,
    sessionId: input.sessionId,
    issueId: input.issueId?.trim() || null,
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
      verifierType: "automated_test",
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
      lines.push(`- \`${src}\``);
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
