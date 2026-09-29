import { assertEquals, assertRejects } from "@std/assert";
import type {
  LinearIssueCreationBinding,
  McpHttpServerConfig,
} from "../../config/mod.ts";
import type { EventInsert } from "../../store/mod.ts";
import type { CommandDefinition } from "../../tools/mod.ts";
import saveIssueSchema from "./linear-save-issue-schema.fixture.ts";
import {
  buildLinearIssueCreationCommand,
  createLinearExtension,
  isLinearCommentCommandId,
  type LinearCallContext,
} from "./mod.ts";

const binding: LinearIssueCreationBinding = {
  teamId: "team_fixture_01",
  projects: { "Synthetic Project": "project_fixture_01" },
};

const server: McpHttpServerConfig = {
  id: "linear",
  transport: "streamable_http",
  url: "https://mcp.example.com/mcp",
  minimumClearance: "loopback",
  auth: { type: "bearer", secret: "linear_mcp" },
  tools: [{ name: "save_issue", effect: "write_external", approval: "ask" }],
  linearIssueCreation: binding,
};

function command(
  id: string,
  defaultDecision: "allow" | "ask",
  result: unknown = { ok: id },
): CommandDefinition {
  return {
    id,
    title: id,
    description: "fixture Linear command",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    permission: {
      effects: [
        defaultDecision === "allow" ? "read.external" : "write.external",
        "emit.event",
      ],
      defaultDecision,
      resources: [`mcp:${id}`],
      network: "configured-external",
      filesystem: "none",
      cost: "none",
    },
    minimumClearance: "loopback",
    redactArguments: true,
    redactResult: true,
    executor: () => result,
  };
}

function callContext(
  events: EventInsert[],
  decision: "approve" | "deny",
): LinearCallContext {
  return {
    sessionId: "01LINEARSESSION000000000000",
    traceId: "0123456789abcdef0123456789abcdef",
    writeEvent: (event) => {
      events.push(event);
    },
    confirmApproval: () =>
      Promise.resolve(
        decision === "approve"
          ? { decision: "approve" }
          : { decision: "deny", reason: "operator said no" },
      ),
    policy: { permissionLevel: "strict", loopback: true },
  };
}

for (const id of ["mcp.linear.create_comment", "mcp.linear.save_comment"]) {
  Deno.test(`isLinearCommentCommandId accepts ${id}`, () => {
    assertEquals(isLinearCommentCommandId(id), true);
  });
}

for (
  const id of ["mcp.linear.get_issue", "mcp.other.save_comment", "save_comment"]
) {
  Deno.test(`isLinearCommentCommandId rejects ${id}`, () => {
    assertEquals(isLinearCommentCommandId(id), false);
  });
}

Deno.test("createLinearExtension resolves the Linear commands others call", () => {
  const getIssue = command("mcp.linear.get_issue", "allow");
  const listComments = command("mcp.linear.list_comments", "allow");
  const saveComment = command("mcp.linear.save_comment", "ask");
  const { id, linear } = createLinearExtension([
    command("mcp.other.get_issue", "allow"),
    getIssue,
    listComments,
    saveComment,
  ]);
  assertEquals(id, "linear");
  assertEquals(linear.getIssue, getIssue);
  assertEquals(linear.listComments, listComments);
  assertEquals(linear.createComment, saveComment);
});

Deno.test("createLinearExtension leaves undiscovered commands absent", () => {
  const { linear } = createLinearExtension([
    command("mcp.linear.get_issue", "allow"),
  ]);
  assertEquals(linear.listComments, undefined);
  assertEquals(linear.createComment, undefined);
});

Deno.test("invoke runs the command under policy and receipts it", async () => {
  const createComment = command("mcp.linear.create_comment", "ask", {
    id: "comment-1",
  });
  const { linear } = createLinearExtension([createComment]);
  const events: EventInsert[] = [];
  assertEquals(
    await linear.invoke(
      createComment,
      { body: "x" },
      callContext(events, "approve"),
    ),
    { id: "comment-1" },
  );
  assertEquals(events.map((event) => event.tool_name), [
    "mcp.linear.create_comment",
  ]);
});

Deno.test("invoke rejects with the reason a denied call gives", async () => {
  const createComment = command("mcp.linear.create_comment", "ask");
  const { linear } = createLinearExtension([createComment]);
  const events: EventInsert[] = [];
  await assertRejects(
    () => linear.invoke(createComment, {}, callContext(events, "deny")),
    Error,
    "operator said no",
  );
  assertEquals(events.length, 1);
});

Deno.test("invoke refuses a command outside the resolved Linear set", async () => {
  const { linear } = createLinearExtension([]);
  await assertRejects(() =>
    linear.invoke(
      command("mcp.linear.get_issue", "allow"),
      {},
      callContext([], "approve"),
    )
  );
});

Deno.test("buildLinearIssueCreationCommand builds the bounded command", () => {
  const built = buildLinearIssueCreationCommand({
    server,
    binding,
    token: "token",
    revision: "2026-07-28",
    discoveredSchema: saveIssueSchema,
    upstreamTool: "save_issue",
    call: () => Promise.reject(new Error("not called")),
  });
  assertEquals(built?.id, "mcp.linear.create_issue");
  assertEquals(built?.permission.resources, ["mcp:linear/save_issue"]);
});

Deno.test("buildLinearIssueCreationCommand refuses an unsupported schema", () => {
  assertEquals(
    buildLinearIssueCreationCommand({
      server,
      binding,
      token: "token",
      revision: "2026-07-28",
      discoveredSchema: { type: "string" },
      upstreamTool: "save_issue",
      call: () => Promise.reject(new Error("not called")),
    }),
    undefined,
  );
});
