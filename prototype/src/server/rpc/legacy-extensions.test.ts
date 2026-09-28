import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import { IdeaPacketRegistry } from "../../idea-packet.ts";
import type { EventInsert } from "../../store/mod.ts";
import type { CommandDefinition } from "../../tools/mod.ts";
import { type RpcContext, RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import {
  buildLegacyExtensionHandlers,
  type LegacyExtensionHandlerDeps,
} from "./legacy-extensions.ts";

function handlers(overrides: Partial<LegacyExtensionHandlerDeps> = {}) {
  return buildLegacyExtensionHandlers({
    fetchSessionEvents: (input) =>
      Promise.resolve(
        [{
          id: "e1",
          sessionId: input.sessionId,
        }] as unknown as WorkbenchSessionEvent[],
      ),
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: false, workspace: null }),
    frictionEventWriter: () => {},
    ideaPacketRegistry: new IdeaPacketRegistry(),
    ...overrides,
  });
}

/** A client that answers every `approval` request with `answer`. */
function approvingClient(
  approvals: unknown[] = [],
  answer: unknown = { decision: "approve" },
): RpcContext {
  return {
    notify: () => Promise.resolve(),
    request: (method, params) => {
      assertEquals(method, "approval");
      approvals.push(params);
      return Promise.resolve(answer);
    },
  };
}

function frictionCommands(input: {
  comments?: string[];
  createCommentError?: string;
  createdBodies?: string[];
} = {}): CommandDefinition[] {
  return [
    {
      id: "mcp.linear.get_issue",
      title: "External MCP: linear/get_issue",
      description: "Configured external MCP read.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      permission: {
        effects: ["read.external", "emit.event"],
        defaultDecision: "allow",
        resources: ["mcp:linear/get_issue"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: () => ({ id: "issue-uuid" }),
    },
    {
      // Comments come from list_comments, not from the issue record: the
      // handler must resolve this tool or refuse before any write.
      id: "mcp.linear.list_comments",
      title: "External MCP: linear/list_comments",
      description: "Configured external MCP paged read.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          limit: { type: "number" },
          cursor: { type: "string" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
      permission: {
        effects: ["read.external", "emit.event"],
        defaultDecision: "allow",
        resources: ["mcp:linear/list_comments"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: () => ({
        comments: (input.comments ?? []).map((body) => ({ body })),
        hasNextPage: false,
      }),
    },
    {
      id: "mcp.linear.create_comment",
      title: "External MCP: linear/create_comment",
      description: "Configured external MCP write.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string" },
        },
        required: ["issueId", "body"],
        additionalProperties: false,
      },
      permission: {
        effects: ["write.external", "emit.event"],
        defaultDecision: "ask",
        resources: ["mcp:linear/create_comment"],
        network: "configured-external",
        filesystem: "none",
        cost: "none",
      },
      minimumClearance: "loopback",
      redactArguments: true,
      redactResult: true,
      executor: (call) => {
        if (input.createCommentError) throw new Error(input.createCommentError);
        input.createdBodies?.push(String(call.arguments.body));
        return { id: "comment-created" };
      },
    },
  ];
}

// Fixture order is an implementation detail. Instrumenting by position let a
// write counter land on the comment read when list_comments was added between
// them, so the assertion stopped watching writes while still passing.
function instrumentCommand(
  commands: CommandDefinition[],
  id: string,
  executor: CommandDefinition["executor"],
): void {
  const command = commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`fixture has no ${id}`);
  command.executor = executor;
}

Deno.test("friction/post numbers comments and preserves write approval", async () => {
  const createdBodies: string[] = [];
  const approvals: unknown[] = [];
  const receiptEvents: EventInsert[] = [];
  const result = await callRpc(
    handlers({
      frictionIssueId: "CHECKPOINT-1",
      frictionNow: () => new Date(2026, 8, 3, 12),
      frictionEventWriter: (event) => {
        receiptEvents.push(event);
      },
      externalMcpCommands: frictionCommands({
        comments: ["F008 · prior", "F010 · E002 · prior escape"],
        createdBodies,
      }),
    }),
    "friction/post",
    {
      severity: "paper-cut",
      escaped: true,
      text: "A concrete operator moment.",
      context: {
        sessionId: "01FRICTIONSESSION00000000000",
        model: "model-slug",
        workspace: "/workspace",
        command: "/packet draft",
      },
    },
    approvingClient(approvals),
  );
  assertEquals(result, {
    number: "F011",
    escapeNumber: "E003",
    commentId: "comment-created",
    firstLine: "F011 · E003 · 2026-09-03 · paper-cut · escaped? yes",
  });
  assertEquals(approvals.length, 1);
  assertObjectMatch(approvals[0] as Record<string, unknown>, {
    commandId: "mcp.linear.create_comment",
  });
  assertEquals(receiptEvents.map((event) => event.tool_name), [
    "mcp.linear.get_issue",
    "mcp.linear.list_comments",
    "mcp.linear.create_comment",
  ]);
  assertObjectMatch(receiptEvents[2] as unknown as Record<string, unknown>, {
    authz_basis: "policy:allow:operator-approved",
    tool_arguments: '{"issueId":"[redacted]","body":"[redacted]"}',
    tool_result: "[redacted]",
  });
  assertStringIncludes(
    createdBodies[0],
    "F011 · E003 · 2026-09-03 · paper-cut · escaped? yes",
  );
});

Deno.test("friction/post validates severity before reading Linear", async () => {
  let reads = 0;
  const commands = frictionCommands();
  instrumentCommand(commands, "mcp.linear.get_issue", () => {
    reads++;
    return { comments: [] };
  });
  const error = await rpcFailure(
    handlers({ externalMcpCommands: commands }),
    "friction/post",
    { severity: "trivial", escaped: false, text: "moment" },
  );
  assertEquals(error.code, RpcErrorCode.invalidParams);
  assertEquals(reads, 0);
});

for (const frictionIssueId of [undefined, "   "]) {
  Deno.test(
    `friction/post requires the operator's friction-checkpoint issue and emits no receipt (${
      JSON.stringify(frictionIssueId)
    })`,
    async () => {
      let reads = 0;
      let writes = 0;
      const receiptEvents: EventInsert[] = [];
      const commands = frictionCommands();
      instrumentCommand(commands, "mcp.linear.get_issue", () => {
        reads++;
        return { comments: [] };
      });
      instrumentCommand(commands, "mcp.linear.create_comment", () => {
        writes++;
        return { id: "comment-created" };
      });
      const error = await rpcFailure(
        handlers({
          frictionIssueId,
          externalMcpCommands: commands,
          frictionEventWriter: (event) => {
            receiptEvents.push(event);
          },
        }),
        "friction/post",
        { severity: "minor", escaped: false, text: "moment" },
      );
      assertStringIncludes(
        error.message,
        "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
      );
      assertEquals(reads, 0);
      assertEquals(writes, 0);
      assertEquals(receiptEvents, []);
    },
  );
}

Deno.test("friction/post names create_comment failure", async () => {
  const error = await rpcFailure(
    handlers({
      frictionIssueId: "EX-100",
      externalMcpCommands: frictionCommands({
        createCommentError: "fixture refused",
      }),
    }),
    "friction/post",
    {
      severity: "minor",
      escaped: false,
      text: "moment",
      context: { sessionId: "01FRICTIONSESSION00000000000" },
    },
    approvingClient(),
  );
  assertStringIncludes(error.message, "create_comment failed");
});

Deno.test("ideas/mark, ideas/list, ideas/get flow", async () => {
  const rpc = handlers({
    fetchSessionEvents: () =>
      Promise.resolve([
        {
          eventId: "evt-idea-1",
          sessionId: "01TEST_IDEA_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Let us capture candidate work items as ideas.",
        },
      ] as unknown as WorkbenchSessionEvent[]),
  });
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId: "01TEST_IDEA_SESSION",
    eventId: "evt-idea-1",
    label: "Capture ideas",
  }) as { idea: { ideaId: string; label: string; description: string } };
  assertEquals(idea.label, "Capture ideas");
  assertEquals(
    idea.description,
    "Let us capture candidate work items as ideas.",
  );

  const { ideas } = await callRpc(rpc, "ideas/list", {
    sessionId: "01TEST_IDEA_SESSION",
  }) as { ideas: Array<{ ideaId: string }> };
  assertEquals(ideas.map((entry) => entry.ideaId), [idea.ideaId]);

  const got = await callRpc(rpc, "ideas/get", { ideaId: idea.ideaId }) as {
    idea: { ideaId: string };
  };
  assertEquals(got.idea.ideaId, idea.ideaId);
});

Deno.test("packets/draft, packets/list, packets/get flow", async () => {
  const rpc = handlers({
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: true, workspace: "/workspaces/project" }),
    fetchSessionEvents: () =>
      Promise.resolve([
        {
          eventId: "evt-pk-1",
          sessionId: "01TEST_PACKET_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Drafting bounded work packets.",
        },
      ] as unknown as WorkbenchSessionEvent[]),
  });
  const draft = await callRpc(rpc, "packets/draft", {
    sessionId: "01TEST_PACKET_SESSION",
    issueId: "ISSUE-258",
    title: "Neutral session model",
    operatorIntent: "Deliver Milestone 3 Packet 0",
  }) as {
    packet: { packetId: string; issueId: string; targetWorkspace: string };
    markdown: string;
  };
  assertEquals(draft.packet.issueId, "ISSUE-258");
  assertEquals(draft.packet.targetWorkspace, "/workspaces/project");
  assertStringIncludes(draft.markdown, "# Work Packet: Neutral session model");
  assertStringIncludes(draft.markdown, "- **Related Issue:** `ISSUE-258`");

  const { packets } = await callRpc(rpc, "packets/list", {
    sessionId: "01TEST_PACKET_SESSION",
  }) as { packets: Array<{ packetId: string }> };
  assertEquals(packets.map((entry) => entry.packetId), [draft.packet.packetId]);

  const got = await callRpc(rpc, "packets/get", {
    packetId: draft.packet.packetId,
  }) as { packet: { packetId: string }; markdown: string };
  assertEquals(got.packet.packetId, draft.packet.packetId);
  assertStringIncludes(got.markdown, "# Work Packet: Neutral session model");
});

Deno.test("ideas and packets fall back to the process-wide registry", async () => {
  const sessionId = `01DEFAULT_REGISTRY_${crypto.randomUUID().slice(0, 8)}`;
  const rpc = handlers({ ideaPacketRegistry: undefined });
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId,
    label: "Default registry",
  }) as { idea: { ideaId: string } };
  // A second handler set without a registry sees the same idea.
  const { ideas } = await callRpc(
    handlers({ ideaPacketRegistry: undefined }),
    "ideas/list",
    { sessionId },
  ) as { ideas: Array<{ ideaId: string }> };
  assertEquals(ideas.map((entry) => entry.ideaId), [idea.ideaId]);
});

Deno.test("packets/draft rejects whitespace-only optional issueId", async () => {
  assertEquals(
    await rpcFailure(handlers(), "packets/draft", {
      sessionId: "01TEST_PACKET_SESSION",
      issueId: "   ",
      title: "Neutral session model",
    }),
    {
      code: RpcErrorCode.invalidParams,
      message: "issueId cannot be empty or whitespace-only",
    },
  );
});

Deno.test("ideas/mark strips complete ANSI CSI escape sequences from the label", async () => {
  const { idea } = await callRpc(handlers(), "ideas/mark", {
    sessionId: "01TEST_ANSI_SESSION",
    label: "Clean \x1b[31mRed\x1b[0m Text",
  }) as { idea: { label: string } };
  assertEquals(idea.label, "Clean Red Text");
  assert(!idea.label.includes("[31m"));
});

Deno.test("ideas/list and packets/list reject missing sessionId", async () => {
  for (const method of ["ideas/list", "packets/list"]) {
    assertEquals(await rpcFailure(handlers(), method, {}), {
      code: RpcErrorCode.invalidParams,
      message: "sessionId is required",
    });
  }
});

Deno.test("packets/draft rejects idea belonging to a different session before fetching context", async () => {
  let fetches = 0;
  const rpc = handlers({
    fetchSessionEvents: () => {
      fetches++;
      return Promise.resolve([]);
    },
  });
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId: "01SESSION_OWNER_A",
    label: "Idea in A",
  }) as { idea: { ideaId: string } };
  const fetchesAfterMark = fetches;
  const error = await rpcFailure(rpc, "packets/draft", {
    sessionId: "01SESSION_OWNER_B",
    ideaId: idea.ideaId,
  });
  assertEquals(error.code, RpcErrorCode.invalidParams);
  assertStringIncludes(error.message, 'belongs to session "01SESSION_OWNER_A"');
  assertEquals(fetches, fetchesAfterMark);
});
