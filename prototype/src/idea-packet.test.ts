import { describe, expect, test } from "vitest";
import {
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  getWorkbenchIdea,
  getWorkbenchPacket,
  IdeaPacketRegistry,
  listWorkbenchIdeas,
  listWorkbenchPackets,
  markWorkbenchIdea,
} from "./idea-packet";
import type { WorkbenchSessionEvent } from "./sessions";

describe("IdeaPacketRegistry", () => {
  test("registers, retrieves, and lists ideas and packets with session filtering", () => {
    const reg = new IdeaPacketRegistry();

    const idea1 = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      label: "Rate limit background processes",
      description: "Ensure background autostart processes have bounded concurrency",
      registry: reg,
    });

    const idea2 = markWorkbenchIdea({
      sessionId: "01SESSION_B",
      label: "Add alternative web search providers",
      registry: reg,
    });

    expect(reg.getIdea(idea1.ideaId)).toEqual(idea1);
    expect(reg.listIdeas("01SESSION_A")).toEqual([idea1]);
    expect(reg.listIdeas("01SESSION_B")).toEqual([idea2]);
    expect(reg.listIdeas()).toHaveLength(2);

    const packet1 = draftWorkPacketFromContext({
      sessionId: "01SESSION_A",
      ideaId: idea1.ideaId,
      issueId: "BIT-340",
      registry: reg,
    });

    expect(reg.getPacket(packet1.packetId)).toEqual(packet1);
    expect(reg.listPackets("01SESSION_A")).toEqual([packet1]);
    expect(reg.listPackets("01SESSION_B")).toEqual([]);

    reg.clear();
    expect(reg.listIdeas()).toEqual([]);
    expect(reg.listPackets()).toEqual([]);
  });
});

describe("markWorkbenchIdea", () => {
  test("throws on empty or whitespace label", () => {
    expect(() =>
      markWorkbenchIdea({
        sessionId: "01SESSION_001",
        label: "   ",
      })
    ).toThrow("idea label cannot be empty");
  });

  test("derives description from matching eventId if not explicitly provided", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "How should we handle background tasks?",
      } as any,
      {
        eventId: "evt-002",
        eventType: "model_response",
        createdAt: "2026-08-15T12:01:00Z",
        content: "We should use a start lock with TTL and prune dead locks.",
      } as any,
    ];

    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_001",
      eventId: "evt-002",
      label: "Start lock with TTL",
      events,
    });

    expect(idea.label).toBe("Start lock with TTL");
    expect(idea.description).toBe(
      "We should use a start lock with TTL and prune dead locks.",
    );
    expect(idea.eventId).toBe("evt-002");
  });

  test("derives description from latest response event if eventId not specified", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "First turn",
      } as any,
      {
        eventId: "evt-002",
        eventType: "agent_response",
        createdAt: "2026-08-15T12:01:00Z",
        content: "Synthesizing three control loops architecture.",
      } as any,
    ];

    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_001",
      label: "Three control loops",
      events,
    });

    expect(idea.description).toBe(
      "Synthesizing three control loops architecture.",
    );
  });
});

describe("draftWorkPacketFromContext", () => {
  test("generates structured work packet cleanly separating source context, operator intent, and criteria", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_100",
      label: "Validate DOLT_PORT before constructing MCP net grants",
      description: "Prevent malformed ports from reaching net grants.",
      registry: reg,
    });

    const events: WorkbenchSessionEvent[] = [
      {
        eventId: "evt-100",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Let's review DOLT_PORT handling.",
      } as any,
      {
        eventId: "evt-101",
        eventType: "tool_call",
        toolName: "read_file",
        toolArguments: { path: "prototype/src/mcp-net-grants.ts" },
        createdAt: "2026-08-15T12:00:10Z",
      } as any,
      {
        eventId: "evt-102",
        eventType: "model_response",
        createdAt: "2026-08-15T12:00:20Z",
        content:
          "DOLT_PORT must be validated as an integer between 1 and 65535.",
      } as any,
    ];

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_100",
      ideaId: idea.ideaId,
      issueId: "BIT-384",
      workspace: "/Users/chris/projects/dyfj",
      events,
      registry: reg,
    });

    expect(packet.sessionId).toBe("01SESSION_100");
    expect(packet.ideaId).toBe(idea.ideaId);
    expect(packet.issueId).toBe("BIT-384");
    expect(packet.title).toBe(
      "Validate DOLT_PORT before constructing MCP net grants",
    );
    expect(packet.targetWorkspace).toBe("/Users/chris/projects/dyfj");
    expect(packet.operatorIntent).toBe(
      "Prevent malformed ports from reaching net grants.",
    );
    expect(packet.sourceContext.contextSources).toContain(
      "prototype/src/mcp-net-grants.ts",
    );
    expect(packet.proposedAcceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    expect(packet.verifierProvenance.verifierType).toBe("automated_test");
    expect(packet.verifierProvenance.independenceNotes).toContain(
      "Verifier evaluation must be independent of generation",
    );
  });

  test("throws when idea belongs to a different session", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      label: "Session A idea",
      registry: reg,
    });

    expect(() =>
      draftWorkPacketFromContext({
        sessionId: "01SESSION_B",
        ideaId: idea.ideaId,
        registry: reg,
      })
    ).toThrow(/belongs to session/);
  });

  test("throws when marking idea with an unknown eventId", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Turn",
      } as any,
    ];

    expect(() =>
      markWorkbenchIdea({
        sessionId: "01SESSION_001",
        eventId: "evt-nonexistent",
        label: "Unknown event idea",
        events,
      })
    ).toThrow(/not found in session events/);
  });

  test("formatWorkPacketMarkdown renders clean markdown with all sections", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_200",
      label: "Expose neutral session model",
      description: "Support /session, /idea mark, and /packet draft",
      registry: reg,
    });

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_200",
      ideaId: idea.ideaId,
      issueId: "BIT-258",
      title: "Neutral session model and idea capture",
      acceptanceCriteria: [
        "Session identity is visible and resumable via /session and dyfj --session",
        "Ideas can be marked and listed in REPL and via RPC",
        "Draft work packets separate context, intent, and acceptance criteria",
      ],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);

    expect(md).toContain("# Work Packet: Neutral session model and idea capture");
    expect(md).toContain(`- **Packet ID:** \`${packet.packetId}\``);
    expect(md).toContain("- **Related Issue:** `BIT-258`");
    expect(md).toContain("## 1. Source Context");
    expect(md).toContain("## 2. Operator Intent");
    expect(md).toContain("Expose neutral session model");
    expect(md).toContain("## 3. Proposed Acceptance Criteria");
    expect(md).toContain(
      "- [ ] Session identity is visible and resumable via /session and dyfj --session",
    );
    expect(md).toContain("## 4. Verification & Provenance");
    expect(md).toContain("- **Primary Verifier:** `human_operator`");
    expect(md).toContain("- **Independence & Oracle Policy:**");
  });
});
