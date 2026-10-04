import {
  assertEquals,
  assertObjectMatch,
  assertStringIncludes,
} from "@std/assert";
import type { EventInsert } from "../../store/mod.ts";
import type { CommandDefinition } from "../../tools/mod.ts";
import { type RpcContext, RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { rpcToolApprover } from "../../server/extensions.ts";
import { createLinearExtension } from "../linear/mod.ts";
import { createFrictionExtension } from "./mod.ts";

// friction/post as the composition root wires it: over the commands the
// linear extension resolved from `externalMcpCommands`, with the server's
// client approver.
function handlers(overrides: {
  frictionIssueId?: string;
  frictionNow?: () => Date;
  frictionEventWriter?: (event: EventInsert) => Promise<void> | void;
  externalMcpCommands?: readonly CommandDefinition[];
} = {}) {
  return createFrictionExtension({
    issueId: overrides.frictionIssueId,
    now: overrides.frictionNow,
    writeEvent: overrides.frictionEventWriter ?? (() => {}),
    permissionLevel: "strict",
  }).rpc({
    linear: createLinearExtension(overrides.externalMcpCommands ?? []).linear,
    toolApprover: rpcToolApprover,
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
  assertStringIncludes(error.message, "comment write failed");
});

for (
  const [missing, message] of [
    ["mcp.linear.get_issue", "get_issue failed"],
    ["mcp.linear.list_comments", "list_comments failed"],
    ["mcp.linear.create_comment", "create_comment/save_comment failed"],
  ]
) {
  Deno.test(`friction/post refuses when ${missing} was not discovered`, async () => {
    const createdBodies: string[] = [];
    const error = await rpcFailure(
      handlers({
        frictionIssueId: "CHECKPOINT-1",
        externalMcpCommands: frictionCommands({ createdBodies }).filter(
          (command) => command.id !== missing,
        ),
      }),
      "friction/post",
      { severity: "minor", escaped: false, text: "moment" },
      approvingClient(),
    );
    assertEquals(error, {
      code: RpcErrorCode.internalError,
      message: `${message}: configured Linear tool is unavailable`,
    });
    assertEquals(createdBodies, []);
  });
}
