import { describe, it } from "@std/testing/bdd";
import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertGreaterOrEqual,
  assertMatch,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  IdeaPacketRegistry,
  markWorkbenchIdea,
} from "./idea-packet.ts";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";

describe("IdeaPacketRegistry", () => {
  it("registers, retrieves, and lists ideas and packets with session filtering", () => {
    const reg = new IdeaPacketRegistry();

    const idea1 = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      label: "Rate limit background processes",
      description:
        "Ensure background autostart processes have bounded concurrency",
      registry: reg,
    });

    const idea2 = markWorkbenchIdea({
      sessionId: "01SESSION_B",
      label: "Add alternative web search providers",
      registry: reg,
    });

    assertEquals(reg.getIdea(idea1.ideaId), idea1);
    assertEquals(reg.listIdeas("01SESSION_A"), [idea1]);
    assertEquals(reg.listIdeas("01SESSION_B"), [idea2]);
    assertEquals(reg.listIdeas().length, 2);

    const packet1 = draftWorkPacketFromContext({
      sessionId: "01SESSION_A",
      ideaId: idea1.ideaId,
      issueId: "ISSUE-340",
      registry: reg,
    });

    assertEquals(reg.getPacket(packet1.packetId), packet1);
    assertEquals(reg.listPackets("01SESSION_A"), [packet1]);
    assertEquals(reg.listPackets("01SESSION_B"), []);

    reg.clear();
    assertEquals(reg.listIdeas(), []);
    assertEquals(reg.listPackets(), []);
  });
});

describe("markWorkbenchIdea", () => {
  it("throws on empty or whitespace label", () => {
    assertThrows(
      () =>
        markWorkbenchIdea({
          registry: new IdeaPacketRegistry(),
          sessionId: "01SESSION_001",
          label: "   ",
        }),
      Error,
      "idea label cannot be empty",
    );
  });

  it("strips surrounding single or double quotes from label", () => {
    const idea1 = markWorkbenchIdea({
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_001",
      label: '"Implement SQLite caching layer for MCP tool calls"',
    });
    assertStrictEquals(
      idea1.label,
      "Implement SQLite caching layer for MCP tool calls",
    );

    const idea2 = markWorkbenchIdea({
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_001",
      label: "'Refactor error reporting'",
    });
    assertStrictEquals(idea2.label, "Refactor error reporting");
  });

  it("derives description from matching eventId if not explicitly provided", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_001",
      eventId: "evt-002",
      label: "Start lock with TTL",
      events,
    });

    assertStrictEquals(idea.label, "Start lock with TTL");
    assertStrictEquals(
      idea.description,
      "We should use a start lock with TTL and prune dead locks.",
    );
    assertStrictEquals(idea.eventId, "evt-002");
  });

  it("derives description from latest response event if eventId not specified", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_001",
      label: "Three control loops",
      events,
    });

    assertStrictEquals(
      idea.description,
      "Synthesizing three control loops architecture.",
    );
  });
});

describe("draftWorkPacketFromContext", () => {
  it("generates structured work packet cleanly separating source context, operator intent, and criteria", () => {
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

    assertStrictEquals(packet.sessionId, "01SESSION_100");
    assertStrictEquals(packet.ideaId, idea.ideaId);
    assertStrictEquals(packet.issueId, "ISSUE-384");
    assertStrictEquals(
      packet.title,
      "Validate DOLT_PORT before constructing MCP net grants",
    );
    assertStrictEquals(packet.targetWorkspace, "/workspaces/project");
    assertStrictEquals(
      packet.operatorIntent,
      "Prevent malformed ports from reaching net grants.",
    );
    assertArrayIncludes(packet.sourceContext.contextSources, [
      "prototype/src/mcp-net-grants.ts",
    ]);
    assertGreaterOrEqual(packet.proposedAcceptanceCriteria.length, 2);
    assertStrictEquals(
      packet.verifierProvenance.verifierType,
      "human_operator",
    );
    assertStringIncludes(
      packet.verifierProvenance.independenceNotes,
      "Verifier evaluation must be independent of generation",
    );
  });

  it("throws when idea belongs to a different session", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      label: "Session A idea",
      registry: reg,
    });

    assertMatch(
      assertThrows(() =>
        draftWorkPacketFromContext({
          sessionId: "01SESSION_B",
          ideaId: idea.ideaId,
          registry: reg,
        }), Error).message,
      /belongs to session/,
    );
  });

  it("throws when marking idea with an unknown eventId", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_001",
        eventId: "evt-001",
        eventType: "session_start",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Turn",
      } as any,
    ];

    assertMatch(
      assertThrows(() =>
        markWorkbenchIdea({
          registry: new IdeaPacketRegistry(),
          sessionId: "01SESSION_001",
          eventId: "evt-nonexistent",
          label: "Unknown event idea",
          events,
        }), Error).message,
      /not found in session events/,
    );
  });

  it("formatWorkPacketMarkdown renders clean markdown with all sections", () => {
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

    assertStringIncludes(
      md,
      "# Work Packet: Neutral session model and idea capture",
    );
    assertStringIncludes(md, `- **Packet ID:** \`${packet.packetId}\``);
    assertStringIncludes(md, "- **Related Issue:** `ISSUE-258`");
    assertStringIncludes(md, "## 1. Source Context");
    assertStringIncludes(md, "- **Primary Verifier:** `human_operator`");
    assertStringIncludes(md, "- **Independence Notes:**");
  });

  it("getPacket and listPackets return defensive copies", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_300",
      title: "Defensive packet",
      registry: reg,
    });

    const retrieved = reg.getPacket(packet.packetId);
    assertNotStrictEquals(retrieved, null);
    retrieved!.sourceContext.contextSources.push("mutated-source");
    retrieved!.proposedAcceptanceCriteria.push("mutated-criteria");

    const secondRetrieval = reg.getPacket(packet.packetId);
    assertEquals(secondRetrieval!.sourceContext.contextSources, []);
    assertEquals(secondRetrieval!.proposedAcceptanceCriteria.length, 2);

    const listed = reg.listPackets("01SESSION_300");
    assertEquals(listed.length, 1);
    listed[0].sourceContext.contextSources.push("mutated-list-source");
    assertEquals(
      reg.getPacket(packet.packetId)!.sourceContext.contextSources,
      [],
    );
  });

  it("registering duplicate idea ID cleans up previous session list and keeps lookup in sync", () => {
    const reg = new IdeaPacketRegistry();
    markWorkbenchIdea({
      sessionId: "01SESSION_A",
      ideaId: "SAME_IDEA_ID",
      label: "Initial Idea",
      registry: reg,
    });

    assertEquals(reg.listIdeas("01SESSION_A").length, 1);

    markWorkbenchIdea({
      sessionId: "01SESSION_A",
      ideaId: "SAME_IDEA_ID",
      label: "Updated Idea in Same Session",
      registry: reg,
    });

    assertEquals(reg.listIdeas("01SESSION_A").length, 1);
    assertStrictEquals(reg.getIdea("SAME_IDEA_ID")?.sessionId, "01SESSION_A");
    assertStrictEquals(
      reg.getIdea("SAME_IDEA_ID")?.label,
      "Updated Idea in Same Session",
    );

    assertThrows(
      () => {
        markWorkbenchIdea({
          sessionId: "01SESSION_B",
          ideaId: "SAME_IDEA_ID",
          label: "Attempted Cross-Session Hijack",
          registry: reg,
        });
      },
      Error,
      "cannot re-register idea",
    );
  });

  it("referenced tool-call event with empty content extracts tool call details as excerpt", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_TC",
      eventId: "evt-tc-1",
      events,
    });

    assertStrictEquals(packet.sourceContext.referencedEventId, "evt-tc-1");
    assertStringIncludes(
      packet.sourceContext.excerpt,
      "[Tool Call: execute_command]",
    );
    assertStringIncludes(packet.sourceContext.excerpt, "deno task test");
  });

  it("session ID longer than 256 chars throws validation error", () => {
    const longSessionId = "A".repeat(300);
    const reg = new IdeaPacketRegistry();
    assertThrows(
      () =>
        markWorkbenchIdea({
          sessionId: longSessionId,
          label: "Long session idea",
          registry: reg,
        }),
      Error,
      "sessionId exceeds maximum length of 256 characters",
    );
  });

  it("formatWorkPacketMarkdown neutralizes markdown heading injections and HTML headings while preserving comparison operators", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_INJECT",
      title: "Title with\nnewlines",
      operatorIntent:
        "Legit intent\r\n\r\n## 4. Injected Section\n> > # Injected Section\n1. > # List Quoted Heading\n<div><h1>Injected HTML</h1></div>\nInjected Setext\n=\nInjected H2 Setext\n-\r# Injected CR Heading\n```sh\n# shell comment\n<h1>inside block</h1>\n```\n```ts\nconst x = 1;",
      acceptanceCriteria: [
        "Criterion 1\nwith newline",
        "`<h1>` Injected Heading in Code Span",
        "<h1>Injected Raw Heading</h1>",
        "p95 latency < 200 ms and memory > 50 MB",
      ],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "# Work Packet: Title with newlines");
    assertStringIncludes(md, "\\## 4. Injected Section");
    assertStringIncludes(md, "> > \\# Injected Section");
    assertStringIncludes(md, "1. > \\# List Quoted Heading");
    assertStringIncludes(md, "<div>&lt;h1&gt;Injected HTML&lt;/h1&gt;</div>");
    assertStringIncludes(md, "Injected Setext\n\\=");
    assertStringIncludes(md, "Injected H2 Setext\n\\-");
    assertStringIncludes(md, "\\# Injected CR Heading");
    assertStringIncludes(
      md,
      "```sh\n# shell comment\n<h1>inside block</h1>\n```",
    );
    assertStringIncludes(md, "```ts\nconst x = 1;\n```");
    assertStringIncludes(md, "- [ ] Criterion 1 with newline");
    assertStringIncludes(md, "- [ ] `<h1>` Injected Heading in Code Span");
    assertStringIncludes(md, "- [ ] &lt;h1&gt;Injected Raw Heading&lt;/h1&gt;");
    assertStringIncludes(md, "- [ ] p95 latency < 200 ms and memory > 50 MB");
  });

  it("registerPacket rejects mismatched packet and sourceContext session IDs", () => {
    const reg = new IdeaPacketRegistry();
    assertThrows(
      () => {
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
      },
      Error,
      "packet sessionId and sourceContext sessionId must match",
    );
  });

  it("recent session events longer than 300 chars include truncation indicator", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_TRUNC",
      events,
    });

    assertStringIncludes(packet.sourceContext.excerpt, "...[truncated]");
  });

  it("markWorkbenchIdea rejects event belonging to a different session", () => {
    const events: WorkbenchSessionEvent[] = [
      {
        sessionId: "01SESSION_OTHER",
        eventId: "evt-diff-sess",
        eventType: "model_response",
        createdAt: "2026-08-15T12:00:00Z",
        content: "Other session response",
      } as any,
    ];

    assertMatch(
      assertThrows(() =>
        markWorkbenchIdea({
          registry: new IdeaPacketRegistry(),
          sessionId: "01SESSION_TARGET",
          eventId: "evt-diff-sess",
          label: "Cross session idea",
          events,
        }), Error).message,
      /not found in session events for session "01SESSION_TARGET"/,
    );
  });

  it("draftWorkPacketFromContext ignores events and file reads from other sessions", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_NATIVE",
      events,
    });

    assertEquals(packet.sourceContext.contextSources, ["native/file.ts"]);
    assertFalse(
      packet.sourceContext.contextSources.includes("foreign/secret.ts"),
    );
  });

  it("markWorkbenchIdea throws when eventId is provided without events array", () => {
    assertMatch(
      assertThrows(() =>
        markWorkbenchIdea({
          registry: new IdeaPacketRegistry(),
          sessionId: "01SESSION_TEST",
          eventId: "evt-123",
          label: "Orphan event idea",
        }), Error).message,
      /cannot mark idea with eventId "evt-123" without supplying session events/,
    );
  });

  it("draftWorkPacketFromContext throws when eventId is provided without events array", () => {
    assertMatch(
      assertThrows(() =>
        draftWorkPacketFromContext({
          registry: new IdeaPacketRegistry(),
          sessionId: "01SESSION_TEST",
          eventId: "evt-123",
          title: "Orphan event packet",
        }), Error).message,
      /cannot draft packet with referenced event "evt-123" without supplying session events/,
    );
  });

  it("blockquote code fences close correctly across varying whitespace and strip escape codes", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_FENCES",
      title: "Fence Whitespace Title",
      operatorIntent:
        ">```ts\n> const y = 2;\n> ```\n\x1b[31m# Heading Outside Fence\x1b[0m",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, ">```ts\n> const y = 2;\n> ```");
    assertStringIncludes(md, "\\# Heading Outside Fence");
    assertFalse(md.includes("\x1b[31m"));
    assertFalse(packet.operatorIntent.includes("\x1b[31m"));
  });

  it("multi-event aggregated excerpt sets referencedEventId to null", () => {
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
      registry: new IdeaPacketRegistry(),
      sessionId: "01SESSION_MULTI",
      events,
    });

    assertStrictEquals(packet.sourceContext.referencedEventId, null);
    assertStringIncludes(
      packet.sourceContext.excerpt,
      "[User]: What is the plan?",
    );
    assertStringIncludes(
      packet.sourceContext.excerpt,
      "[Assistant]: Here is the plan.",
    );
  });

  it("preserves headings inside list-nested and numbered list code fences", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_LIST_FENCE",
      operatorIntent:
        "- ```sh\n  # shell comment\n  echo hello\n  ```\n\n1. ```python\n   # python comment\n   ```\n\n# Real Heading",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "- ```sh\n  # shell comment\n  echo hello\n  ```");
    assertStringIncludes(md, "1. ```python\n   # python comment\n   ```");
    assertStringIncludes(md, "\\# Real Heading");
  });

  it("strips C1 control characters from headings and criteria", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_C1",
      title: "Title with \u009B2J C1 control",
      operatorIntent: "Intent with \u0080\u009F controls",
      acceptanceCriteria: ["Criterion with \u0090 control"],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertFalse(md.includes("\u009B"));
    assertFalse(md.includes("\u0080"));
    assertFalse(md.includes("\u009F"));
    assertFalse(md.includes("\u0090"));
    assertFalse(packet.title.includes("\u009B"));
    assertFalse(packet.operatorIntent.includes("\u0080"));
  });

  it("escapes multiline HTML headings outside code blocks", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_ML_HTML",
      operatorIntent: '<h1\nclass="injected">Injected Heading</h1>',
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, '&lt;h1\nclass="injected"&gt;');
    assertStringIncludes(md, "&lt;/h1&gt;");
  });

  it("preserves multiple internal spaces in metadata code spans and criteria", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_SPACES",
      workspace: "/work/My  Custom  Path",
      acceptanceCriteria: ["Verify `printf 'a  b'` output"],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "`/work/My  Custom  Path`");
    assertStringIncludes(md, "`printf 'a  b'`");
  });

  it("4-space indented code blocks do not suppress heading escaping", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_4SP",
      operatorIntent: "    ```\n# Injected Heading\n    ```",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "\\# Injected Heading");
  });

  it("escaped backticks do not bypass HTML heading escaping in criteria", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_ESC_TICKS",
      acceptanceCriteria: ["\\`<h1>Injected</h1>\\`"],
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "&lt;h1&gt;Injected&lt;/h1&gt;");
  });

  it("raw HTML blocks with attribute-bearing headings are neutralized", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_RAW_HTML",
      operatorIntent: "<div><h1 class=x>Injected Heading</h1></div>",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(
      md,
      "<div>&lt;h1 class=x&gt;Injected Heading&lt;/h1&gt;</div>",
    );
  });

  it("markWorkbenchIdea strips C1 controls from event-derived description", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_C1_DESC",
      label: "C1 Test Idea",
      eventId: "evt_1",
      events: [
        {
          eventId: "evt_1",
          sessionId: "01SESSION_C1_DESC",
          eventType: "model_response",
          content: "Response with \u009B2J C1 control byte",
        } as any,
      ],
      registry: reg,
    });

    assertFalse(idea.description.includes("\u009B"));
  });

  it("list-nested dangling code fence closes with whitespace indentation", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_LIST_DANGLE",
      operatorIntent: "- ```sh\n  echo hello",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "- ```sh\n  echo hello\n  ```");
    assertFalse(md.includes("- ```sh\n  echo hello\n- ```"));
  });

  it("multi-digit ordered list code fences close properly with matching indentation", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_MULTIDIGIT_LIST",
      operatorIntent: "10. ```sh\n    echo multi\n    ```\n# Injected Heading",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "10. ```sh\n    echo multi\n    ```");
    assertStringIncludes(md, "\\# Injected Heading");
  });

  it("tab-indented fences do not close root code fences", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_TAB_FENCE",
      operatorIntent: "```sh\necho test\n\t```\n# code comment\n```",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "```sh\necho test\n\t```\n# code comment\n```");
    assertFalse(md.includes("\\# code comment"));
  });

  it("code fences inside list items protect headings until closed by matching indented fence", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_DIFF_LIST",
      operatorIntent: "- ```sh\n  echo test\n  # code comment\n  ```",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "# code comment");
    assertFalse(md.includes("\\# code comment"));
  });

  it("re-registering idea or packet under a different session throws an error", () => {
    const reg = new IdeaPacketRegistry();
    const idea1 = markWorkbenchIdea({
      sessionId: "01SESSION_A",
      ideaId: "01IDEA_CROSS_SESS",
      label: "Idea in Session A",
      registry: reg,
    });
    assertStrictEquals(idea1.ideaId, "01IDEA_CROSS_SESS");

    assertThrows(
      () => {
        markWorkbenchIdea({
          sessionId: "01SESSION_B",
          ideaId: "01IDEA_CROSS_SESS",
          label: "Idea Hijack",
          registry: reg,
        });
      },
      Error,
      "cannot re-register idea",
    );
  });

  it("event resolution searches beyond 2000 events without failing", () => {
    const reg = new IdeaPacketRegistry();
    const events = [];
    events.push({
      eventId: "evt_early",
      sessionId: "01SESSION_DEEP_EVTS",
      eventType: "user_prompt",
      content: "Early event content",
    } as any);
    for (let i = 0; i < 2500; i++) {
      events.push({
        eventId: `evt_filler_${i}`,
        sessionId: "01SESSION_DEEP_EVTS",
        eventType: "turn_start",
      } as any);
    }

    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_DEEP_EVTS",
      eventId: "evt_early",
      label: "Deep Event Idea",
      events,
      registry: reg,
    });

    assertStrictEquals(idea.description, "Early event content");
  });

  it("idea label sanitizes ANSI escape sequences and C1 control bytes upon registration", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_LABEL_SAN",
      label: "Clean \x1b[2JLabel \u009Bwith ANSI",
      registry: reg,
    });

    assertFalse(idea.label.includes("\x1b[2J"));
    assertFalse(idea.label.includes("\u009B"));
    assertStrictEquals(idea.label, "Clean Label with ANSI");
  });

  it("registering a packet referencing an idea from a different session throws an error", () => {
    const reg = new IdeaPacketRegistry();
    const ideaA = markWorkbenchIdea({
      sessionId: "01SESSION_OWNER_A",
      ideaId: "01IDEA_OWNER_A",
      label: "Idea in session A",
      registry: reg,
    });

    const packetDraft = draftWorkPacketFromContext({
      sessionId: "01SESSION_OWNER_A",
      idea: ideaA,
      registry: reg,
    });

    assertThrows(
      () => {
        reg.registerPacket({
          ...packetDraft,
          sessionId: "01SESSION_OWNER_B",
          sourceContext: {
            ...packetDraft.sourceContext,
            sessionId: "01SESSION_OWNER_B",
          },
        });
      },
      Error,
      'packet idea "01IDEA_OWNER_A" belongs to session "01SESSION_OWNER_A"',
    );
  });

  it("idea label consisting solely of ANSI escapes or whitespace is rejected", () => {
    const reg = new IdeaPacketRegistry();
    assertThrows(
      () => {
        markWorkbenchIdea({
          sessionId: "01SESSION_BLANK_ANSI",
          label: "\x1b[2J\x1b[0m   ",
          registry: reg,
        });
      },
      Error,
      "idea label cannot be empty or whitespace-only",
    );
  });

  it("differing nested list markers inside blockquotes exit list item and escape subsequent headings", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_BQ_DIFF_LIST",
      operatorIntent:
        "> - ```sh\n>   echo test\n> 1. ```\n>   # code comment\n>   ```",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "\\# code comment");
  });

  it("blockquote container implicit exit resets fence state and escapes subsequent headings", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_BQ_EXIT",
      operatorIntent: "> ```sh\n> echo inside\n\n# Heading Outside",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "\\# Heading Outside");
    assertFalse(md.includes("\n> ```\n"));
  });

  it("drafting packet with ANSI-only title falls back to default title without emitting empty header", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_ANSI_TITLE",
      title: "\x1b[2J\x1b[0m",
      operatorIntent: "Work intent",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "# Work Packet: Work intent");
    assertNotStrictEquals(md, "# Work Packet: \n");
  });

  it("OSC and Fe ANSI escape sequences are completely stripped from labels and headings", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_OSC",
      label: "Clean \x1b]0;Title\x07Label \x1bNEscaped",
      registry: reg,
    });

    assertStrictEquals(idea.label, "Clean Label Escaped");
  });

  it("implicit container exit escapes subsequent raw HTML headings", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_HTML_BQ_EXIT",
      operatorIntent: "> ```sh\n> code\n<h1>Injected</h1>",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "&lt;h1&gt;Injected&lt;/h1&gt;");
  });

  it("evicted idea session prevents re-registering the same idea ID under a different session", () => {
    const reg = new IdeaPacketRegistry();
    // Register idea in session A
    markWorkbenchIdea({
      sessionId: "01SESSION_EVICT_A",
      ideaId: "01IDEA_SHARED_ID",
      label: "Initial Idea in A",
      registry: reg,
    });

    // Fill registry with 105 other sessions to force eviction of session A from ideasBySession
    for (let i = 0; i < 105; i++) {
      markWorkbenchIdea({
        sessionId: `01SESSION_FILLER_${i}`,
        label: `Filler Idea ${i}`,
        registry: reg,
      });
    }

    // Verify session A is evicted from active session map
    assertEquals(reg.listIdeas("01SESSION_EVICT_A").length, 0);

    // Attempting to re-register the same ideaId in session B should fail
    assertThrows(
      () => {
        markWorkbenchIdea({
          sessionId: "01SESSION_EVICT_B",
          ideaId: "01IDEA_SHARED_ID",
          label: "Hijacked Idea in B",
          registry: reg,
        });
      },
      Error,
      'cannot re-register idea "01IDEA_SHARED_ID" under session "01SESSION_EVICT_B"',
    );
  });

  it("four-space indented code blocks preserve comments without heading escaping", () => {
    const reg = new IdeaPacketRegistry();
    const packet = draftWorkPacketFromContext({
      sessionId: "01SESSION_INDENTED_CODE",
      operatorIntent: "Here is code:\n    # comment\n    def foo(): pass",
      registry: reg,
    });

    const md = formatWorkPacketMarkdown(packet);
    assertStringIncludes(md, "    # comment");
    assertFalse(md.includes("    \\# comment"));
  });

  it("idea remains resolvable when its session is evicted if an active packet references it", () => {
    const reg = new IdeaPacketRegistry();
    const idea = markWorkbenchIdea({
      sessionId: "01SESSION_RETAIN_A",
      ideaId: "01IDEA_RETAINED",
      label: "Retained idea",
      registry: reg,
    });

    draftWorkPacketFromContext({
      sessionId: "01SESSION_RETAIN_A",
      ideaId: idea.ideaId,
      registry: reg,
    });

    // Evict session A's ideas by adding 105 other idea sessions
    for (let i = 0; i < 105; i++) {
      markWorkbenchIdea({
        sessionId: `01SESSION_OTHER_${i}`,
        label: `Other ${i}`,
        registry: reg,
      });
    }

    // Session A is evicted from ideasBySession
    assertEquals(reg.listIdeas("01SESSION_RETAIN_A").length, 0);
    // But getIdea still resolves the idea because the packet references it!
    assertNotStrictEquals(reg.getIdea("01IDEA_RETAINED"), null);
    assertStrictEquals(reg.getIdea("01IDEA_RETAINED")?.label, "Retained idea");
  });
});
