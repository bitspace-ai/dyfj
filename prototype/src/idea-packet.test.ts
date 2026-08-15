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
      issueId: "ISSUE-340",
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
        sessionId: "01SESSION_001",
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "How should we handle background tasks?",
      } as any,
      {
        sessionId: "01SESSION_001",
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
        sessionId: "01SESSION_001",
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "First turn",
      } as any,
      {
        sessionId: "01SESSION_001",
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
        sessionId: "01SESSION_100",
        eventId: "evt-100",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Let's review DOLT_PORT handling.",
      } as any,
      {
        sessionId: "01SESSION_100",
        eventId: "evt-101",
        eventType: "tool_call",
        toolName: "read_file",
        toolArguments: { path: "prototype/src/mcp-net-grants.ts" },
        createdAt: "2026-08-15T12:00:10Z",
      } as any,
      {
        sessionId: "01SESSION_100",
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
      issueId: "ISSUE-384",
      operatorIntent: "Prevent malformed ports from reaching net grants.",
      workspace: "/workspaces/project",
      events,
      registry: reg,
    });

    expect(packet.sessionId).toBe("01SESSION_100");
    expect(packet.ideaId).toBe(idea.ideaId);
    expect(packet.issueId).toBe("ISSUE-384");
    expect(packet.title).toBe(
      "Validate DOLT_PORT before constructing MCP net grants",
    );
    expect(packet.targetWorkspace).toBe("/workspaces/project");
    expect(packet.operatorIntent).toBe(
      "Prevent malformed ports from reaching net grants.",
    );
    expect(packet.sourceContext.contextSources).toContain(
      "prototype/src/mcp-net-grants.ts",
    );
    expect(packet.proposedAcceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    expect(packet.verifierProvenance.verifierType).toBe("human_operator");
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
        sessionId: "01SESSION_001",
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
      issueId: "ISSUE-258",
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
    expect(md).toContain("- **Related Issue:** `ISSUE-258`");
    expect(md).toContain("## 1. Source Context");
    expect(md).toContain("- **Primary Verifier:** `human_operator`");
    expect(md).toContain("- **Independence Notes:**");
  });

  test("getPacket and listPackets return defensive copies", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_300",
      title: "Defensive packet",
      registry: reg,
    });

    const retrieved = reg.getPacket(packet.packetId);
    expect(retrieved).not.toBeNull();
    retrieved!.sourceContext.contextSources.push("mutated-source");
    retrieved!.proposedAcceptanceCriteria.push("mutated-criteria");

    const secondRetrieval = reg.getPacket(packet.packetId);
    expect(secondRetrieval!.sourceContext.contextSources).toEqual([]);
    expect(secondRetrieval!.proposedAcceptanceCriteria).toHaveLength(2);

    const listed = reg.listPackets("01SESSION_300");
    expect(listed).toHaveLength(1);
    listed[0].sourceContext.contextSources.push("mutated-list-source");
    expect(reg.getPacket(packet.packetId)!.sourceContext.contextSources).toEqual([]);
  });

  test("registering duplicate idea ID cleans up previous session list and keeps lookup in sync", () => {
    const reg = new IdeaPacketRegistry();
    const idea1 = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      ideaId: "SAME_IDEA_ID",
      label: "Initial Idea",
      registry: reg,
    });

    expect(reg.listIdeas("01SESSION_A")).toHaveLength(1);

    const idea2 = markWorkbenchIdea({
      sessionId: "01SESSION_B",
      ideaId: "SAME_IDEA_ID",
      label: "Updated Idea in New Session",
      registry: reg,
    });

    expect(reg.listIdeas("01SESSION_A")).toHaveLength(0);
    expect(reg.listIdeas("01SESSION_B")).toHaveLength(1);
    expect(reg.getIdea("SAME_IDEA_ID")?.sessionId).toBe("01SESSION_B");
    expect(reg.getIdea("SAME_IDEA_ID")?.label).toBe("Updated Idea in New Session");
  });

  test("referenced tool-call event with empty content extracts tool call details as excerpt", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_TC",
        eventId: "evt-tc-1",
        eventType: "tool_call",
        toolName: "execute_command",
        toolArguments: { command: "deno task test" },
        createdAt: "2026-08-15T12:00:00Z",
      } as any,
    ];

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_TC",
      eventId: "evt-tc-1",
      events,
    });

    expect(packet.sourceContext.referencedEventId).toBe("evt-tc-1");
    expect(packet.sourceContext.excerpt).toContain("[Tool Call: execute_command]");
    expect(packet.sourceContext.excerpt).toContain("deno task test");
  });

  test("session ID longer than 256 chars throws validation error", () => {
    const longSessionId = "A".repeat(300);
    const reg = new IdeaPacketRegistry();
    expect(() =>
      markWorkbenchIdea({
        sessionId: longSessionId,
        label: "Long session idea",
        registry: reg,
      })
    ).toThrow("sessionId exceeds maximum length of 256 characters");
  });

  test("formatWorkPacketMarkdown neutralizes markdown heading injections and HTML headings while preserving comparison operators", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_INJECT",
      title: "Title with\nnewlines",
      operatorIntent: "Legit intent\r\n\r\n## 4. Injected Section\n> > # Injected Section\n1. > # List Quoted Heading\n<div><h1>Injected HTML</h1></div>\nInjected Setext\n=\nInjected H2 Setext\n-\r# Injected CR Heading\n```sh\n# shell comment\n<h1>inside block</h1>\n```\n```ts\nconst x = 1;",
      acceptanceCriteria: [
        "Criterion 1\nwith newline",
        "`<h1>` Injected Heading in Code Span",
        "<h1>Injected Raw Heading</h1>",
        "p95 latency < 200 ms and memory > 50 MB",
      ],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).toContain("# Work Packet: Title with newlines");
    expect(md).toContain("\\## 4. Injected Section");
    expect(md).toContain("> > \\# Injected Section");
    expect(md).toContain("1. > \\# List Quoted Heading");
    expect(md).toContain("<div>\\<h1\\>Injected HTML\\</h1\\></div>");
    expect(md).toContain("Injected Setext\n\\=");
    expect(md).toContain("Injected H2 Setext\n\\-");
    expect(md).toContain("\\# Injected CR Heading");
    expect(md).toContain("```sh\n# shell comment\n<h1>inside block</h1>\n```");
    expect(md).toContain("```ts\nconst x = 1;\n```");
    expect(md).toContain("- [ ] Criterion 1 with newline");
    expect(md).toContain("- [ ] `<h1>` Injected Heading in Code Span");
    expect(md).toContain("- [ ] \\<h1\\>Injected Raw Heading\\</h1\\>");
    expect(md).toContain("- [ ] p95 latency < 200 ms and memory > 50 MB");
  });

  test("registerPacket rejects mismatched packet and sourceContext session IDs", () => {
    const reg = new IdeaPacketRegistry();
    expect(() => {
      reg.registerPacket({
        packetId: "01PACKET000000000000000001",
        ideaId: null,
        sessionId: "01SESSION_A",
        issueId: null,
        title: "Cross session packet",
        targetWorkspace: null,
        sourceContext: {
          sessionId: "01SESSION_B",
          referencedEventId: null,
          excerpt: "Excerpt from B",
          contextSources: [],
        },
        operatorIntent: "Intent",
        proposedAcceptanceCriteria: [],
        verifierProvenance: {
          verifierType: "human_operator",
          independenceNotes: "Notes",
        },
        createdAt: "2026-08-15T12:00:00Z",
      });
    }).toThrow("packet sessionId and sourceContext sessionId must match");
  });

  test("recent session events longer than 300 chars include truncation indicator", () => {
    const longContent = "A".repeat(400);
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_TRUNC",
        eventId: "evt-long-1",
        eventType: "model_response",
        createdAt: "2026-08-15T12:00:00Z",
        content: longContent,
      } as any,
    ];

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_TRUNC",
      events,
    });

    expect(packet.sourceContext.excerpt).toContain("...[truncated]");
  });

  test("markWorkbenchIdea rejects event belonging to a different session", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_OTHER",
        eventId: "evt-diff-sess",
        eventType: "model_response",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Other session response",
      } as any,
    ];

    expect(() =>
      markWorkbenchIdea({
        sessionId: "01SESSION_TARGET",
        eventId: "evt-diff-sess",
        label: "Cross session idea",
        events,
      })
    ).toThrow(/not found in session events for session "01SESSION_TARGET"/);
  });

  test("draftWorkPacketFromContext ignores events and file reads from other sessions", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_FOREIGN",
        eventId: "evt-foreign-1",
        eventType: "tool_call",
        toolName: "read_file",
        toolArguments: { path: "foreign/secret.ts" },
        createdAt: "2026-08-15T12:00:00Z",
      } as any,
      {
        sessionId: "01SESSION_NATIVE",
        eventId: "evt-native-1",
        eventType: "tool_call",
        toolName: "read_file",
        toolArguments: { path: "native/file.ts" },
        createdAt: "2026-08-15T12:01:00Z",
      } as any,
    ];

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_NATIVE",
      events,
    });

    expect(packet.sourceContext.contextSources).toEqual(["native/file.ts"]);
    expect(packet.sourceContext.contextSources).not.toContain("foreign/secret.ts");
  });

  test("markWorkbenchIdea throws when eventId is provided without events array", () => {
    expect(() =>
      markWorkbenchIdea({
        sessionId: "01SESSION_TEST",
        eventId: "evt-123",
        label: "Orphan event idea",
      })
    ).toThrow(/cannot mark idea with eventId "evt-123" without supplying session events/);
  });

  test("draftWorkPacketFromContext throws when eventId is provided without events array", () => {
    expect(() =>
      draftWorkPacketFromContext({
        sessionId: "01SESSION_TEST",
        eventId: "evt-123",
        title: "Orphan event packet",
      })
    ).toThrow(/cannot draft packet with referenced event "evt-123" without supplying session events/);
  });

  test("blockquote code fences close correctly across varying whitespace and strip escape codes", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_FENCES",
      title: "Fence Whitespace Title",
      operatorIntent: ">```ts\n> const y = 2;\n> ```\n\x1b[31m# Heading Outside Fence\x1b[0m",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).toContain(">```ts\n> const y = 2;\n> ```");
    expect(md).toContain("\\# Heading Outside Fence");
    expect(md).not.toContain("\x1b[31m");
    expect(packet.operatorIntent).not.toContain("\x1b[31m");
  });

  test("multi-event aggregated excerpt sets referencedEventId to null", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_MULTI",
        eventId: "evt-1",
        eventType: "session_start",
        content: "What is the plan?",
        createdAt: "2026-08-15T12:00:00Z",
      } as any,
      {
        sessionId: "01SESSION_MULTI",
        eventId: "evt-2",
        eventType: "model_response",
        content: "Here is the plan.",
        createdAt: "2026-08-15T12:01:00Z",
      } as any,
    ];

    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_MULTI",
      events,
    });

    expect(packet.sourceContext.referencedEventId).toBeNull();
    expect(packet.sourceContext.excerpt).toContain("[User]: What is the plan?");
    expect(packet.sourceContext.excerpt).toContain("[Assistant]: Here is the plan.");
  });

  test("preserves headings inside list-nested and numbered list code fences", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_LIST_FENCE",
      operatorIntent: "- ```sh\n  # shell comment\n  echo hello\n  ```\n\n1. ```python\n   # python comment\n   ```\n\n# Real Heading",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).toContain("- ```sh\n  # shell comment\n  echo hello\n  ```");
    expect(md).toContain("1. ```python\n   # python comment\n   ```");
    expect(md).toContain("\\# Real Heading");
  });

  test("strips C1 control characters from headings and criteria", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_C1",
      title: "Title with \u009B2J C1 control",
      operatorIntent: "Intent with \u0080\u009F controls",
      acceptanceCriteria: ["Criterion with \u0090 control"],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).not.toContain("\u009B");
    expect(md).not.toContain("\u0080");
    expect(md).not.toContain("\u009F");
    expect(md).not.toContain("\u0090");
    expect(packet.title).not.toContain("\u009B");
    expect(packet.operatorIntent).not.toContain("\u0080");
  });

  test("escapes multiline HTML headings outside code blocks", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_ML_HTML",
      operatorIntent: "<h1\nclass=\"injected\">Injected Heading</h1>",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).toContain("\\<h1\nclass=\"injected\"\\>");
    expect(md).toContain("\\</h1\\>");
  });

  test("preserves multiple internal spaces in metadata code spans and criteria", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_SPACES",
      workspace: "/work/My  Custom  Path",
      acceptanceCriteria: ["Verify `printf 'a  b'` output"],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    expect(md).toContain("`/work/My  Custom  Path`");
    expect(md).toContain("`printf 'a  b'`");
  });
});
