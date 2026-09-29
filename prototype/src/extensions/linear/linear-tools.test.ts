import { describe, it } from "@std/testing/bdd";
import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, type Spy, spy } from "@std/testing/mock";
import saveIssueSchema from "./linear-save-issue-schema.fixture.ts";
import type {
  LinearIssueCreationBinding,
  McpHttpServerConfig,
} from "../../config/mod.ts";
import {
  type ConfirmToolApproval,
  createCommandRegistry,
  invokeCommandWithEvent,
  type JsonSchemaObject,
} from "../../tools/mod.ts";
import {
  boundedLinearCreateIssueSchema,
  buildBoundedLinearCreateIssueCommand,
  type LinearCreationUpstreamTool,
  type LinearIssueMcpCall,
  type LinearIssueMcpResult,
  projectLinearCreationUpstreamSchema,
  projectLinearIssueCreationReceipt,
  supportsBoundedLinearCreateIssue,
} from "./linear-tools.ts";

const binding: LinearIssueCreationBinding = {
  teamId: "team_fixture_01",
  projects: Object.assign(Object.create(null), {
    "Synthetic Project": "project_fixture_01",
    "Second Project": "project_fixture_02",
  }),
};

const server: McpHttpServerConfig = {
  id: "linear",
  transport: "streamable_http",
  url: "https://mcp.example.com/mcp",
  minimumClearance: "loopback",
  auth: { type: "bearer", secret: "linear_mcp" },
  tools: [{
    name: "create_issue",
    effect: "write_external",
    approval: "ask",
  }],
  linearIssueCreation: binding,
};

const upstreamSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    team: { type: "string" },
    project: { type: "string" },
    priority: { type: "integer" },
    relatedTo: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["title", "team"],
  additionalProperties: false,
};

const INDETERMINATE =
  "Linear issue creation is indeterminate; reconcile in Linear before retrying.";

// A Linear MCP call fake that records its calls; without an implementation it
// resolves to nothing.
function callSpy(
  impl: LinearIssueMcpCall = () =>
    Promise.resolve(undefined as unknown as LinearIssueMcpResult),
) {
  return spy((input: Parameters<LinearIssueMcpCall>[0]) => impl(input));
}

type ApprovalSpy = Spy<
  unknown,
  Parameters<ConfirmToolApproval>,
  ReturnType<ConfirmToolApproval>
>;

// An approver fake that records its calls and answers every one `decision`.
function approvalSpy(decision: "approve" | "deny"): ApprovalSpy {
  return spy((..._request: Parameters<ConfirmToolApproval>) =>
    Promise.resolve({ decision })
  );
}

function successResult(identifier = "SYN-101") {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        identifier,
        title: "must not persist",
        team: { id: binding.teamId },
        project: { id: binding.projects["Synthetic Project"] },
      }),
    }],
    isError: false,
  };
}

function commandWith(
  call: LinearIssueMcpCall,
  upstreamTool: LinearCreationUpstreamTool,
) {
  const command = buildBoundedLinearCreateIssueCommand({
    server,
    binding,
    token: "fixture-token",
    revision: "2026-07-28",
    upstreamSchema: upstreamTool === "save_issue"
      ? projectLinearCreationUpstreamSchema(saveIssueSchema, binding)!
      : upstreamSchema,
    upstreamTool,
    call,
  });
  if (command === undefined) throw new Error("fixture schema was rejected");
  return command;
}

function invocationArguments(overrides: Record<string, unknown> = {}) {
  return {
    title: "Synthetic issue",
    description: "Synthetic description",
    project: "Synthetic Project",
    priority: 2,
    relatedTo: ["SYN-7"],
    ...overrides,
  };
}

async function invokeWith(
  call: LinearIssueMcpCall,
  args: Record<string, unknown> = invocationArguments(),
  approve: ApprovalSpy = approvalSpy("approve"),
  upstreamTool: LinearCreationUpstreamTool = "create_issue",
) {
  const events: Array<Record<string, unknown> & { content?: string }> = [];
  const result = await invokeCommandWithEvent(
    createCommandRegistry([commandWith(call, upstreamTool)]),
    {
      commandId: "mcp.linear.create_issue",
      callId: "call-fixture",
      caller: { principalId: "operator", principalType: "human" },
      arguments: args,
    },
    {
      sessionId: "session-fixture",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      writeEvent: (event: unknown) => {
        events.push(event as Record<string, unknown> & { content?: string });
      },
    },
    approve,
    { permissionLevel: "operator", loopback: true },
  );
  return { result, events, approve };
}

const invalidArgumentCases: Array<[string, Record<string, unknown>]> = [
  ["whitespace title", { title: "   " }],
  ["long title", { title: "x".repeat(201) }],
  ["long description", { description: "x".repeat(16_001) }],
  ["unknown project", { project: "Not Configured" }],
  ["fractional priority", { priority: 1.5 }],
  ["out-of-range priority", { priority: 5 }],
  ["too many relations", {
    relatedTo: Array.from({ length: 11 }, (_, i) => `SYN-${i + 1}`),
  }],
  ["duplicate relations", { relatedTo: ["SYN-1", "SYN-1"] }],
  ["malformed relation", { relatedTo: ["not-an-issue"] }],
  ["unknown field", { rationale: "model supplied" }],
  ["update ID", { id: "SYN-101" }],
  ["update patch", { patch: [] }],
  ["template", { template: "unapproved template" }],
  ["state", { state: "Done" }],
];

const indeterminateCases: Array<[string, LinearIssueMcpCall]> = [
  [
    "malformed JSON",
    async () => ({ content: [{ type: "text", text: "not-json" }] }),
  ],
  ["multiple text results", async () => ({
    content: [
      { type: "text", text: "untrusted details one" },
      { type: "text", text: "untrusted details two" },
    ],
  })],
  ["missing identifier", async () => ({
    structuredContent: {
      teamId: binding.teamId,
      projectId: binding.projects["Synthetic Project"],
    },
  })],
  ["mismatched team", async () => ({
    structuredContent: {
      identifier: "SYN-102",
      teamId: "different_team",
      projectId: binding.projects["Synthetic Project"],
    },
  })],
  ["mismatched project", async () => ({
    structuredContent: {
      identifier: "SYN-103",
      teamId: binding.teamId,
      projectId: "different_project",
    },
  })],
  ["conflicting association evidence", async () => ({
    structuredContent: {
      identifier: "SYN-104",
      teamId: binding.teamId,
      team: { id: "different_team" },
      projectId: binding.projects["Synthetic Project"],
    },
  })],
  ["server error", async () => ({ isError: true })],
  ["transport timeout", async () => {
    throw new Error("timeout with untrusted details");
  }],
];

for (const upstreamTool of ["create_issue", "save_issue"] as const) {
  describe(`bounded Linear creation via ${String(upstreamTool)}`, () => {
    const invoke = (
      call: LinearIssueMcpCall,
      args?: Record<string, unknown>,
      approve?: ApprovalSpy,
    ) => invokeWith(call, args, approve, upstreamTool);
    it("projects only bounded model fields and exact configured project names", () => {
      const schema = boundedLinearCreateIssueSchema(binding);
      assertEquals(Object.keys(schema.properties ?? {}), [
        "title",
        "description",
        "project",
        "priority",
        "relatedTo",
      ]);
      assertEquals(schema.properties?.project?.enum, [
        "Synthetic Project",
        "Second Project",
      ]);
      assertFalse("team" in (schema.properties as object));
      assertStrictEquals(schema.additionalProperties, false);
    });

    it("requires the discovered connector to accept every mapped field", () => {
      assertStrictEquals(
        supportsBoundedLinearCreateIssue(upstreamSchema, binding),
        true,
      );
      assertStrictEquals(
        supportsBoundedLinearCreateIssue({
          ...upstreamSchema,
          properties: {
            ...upstreamSchema.properties,
            relatedTo: { type: "string" },
          },
        }, binding),
        false,
      );
      assertStrictEquals(
        supportsBoundedLinearCreateIssue({
          ...upstreamSchema,
          required: ["title", "unsupportedRequiredField"],
        }, binding),
        false,
      );
      assertStrictEquals(
        supportsBoundedLinearCreateIssue({
          ...upstreamSchema,
          required: ["title", "relatedTo"],
        }, binding),
        false,
      );
      assertStrictEquals(
        supportsBoundedLinearCreateIssue({
          ...upstreamSchema,
          properties: {
            ...upstreamSchema.properties,
            team: { type: "string", enum: ["different_team"] },
          },
        }, binding),
        false,
      );
    });

    it("injects configured IDs, asks once, calls once, and persists only the identifier", async () => {
      const call = callSpy(async () => successResult());
      const { result, events, approve } = await invoke(call);

      assertSpyCalls(approve, 1);
      assertSpyCalls(call, 1);
      assertStrictEquals(call.calls[0].args[0].tool, upstreamTool);
      assertFalse("id" in (call.calls[0].args[0].arguments as object));
      assertFalse("patch" in (call.calls[0].args[0].arguments as object));
      assertEquals(call.calls[0].args[0].arguments, {
        title: "Synthetic issue",
        description: "Synthetic description",
        team: "team_fixture_01",
        project: "project_fixture_01",
        priority: 2,
        relatedTo: ["SYN-7"],
      });
      assertEquals(result, {
        decision: "allow",
        authzBasis: "policy:allow:operator-approved",
        isError: false,
        result: "SYN-101",
      });
      assertObjectMatch(events[0] as unknown as Record<string, unknown>, {
        tool_arguments:
          '{"title":"[redacted]","description":"[redacted]","project":"[redacted]","priority":"[redacted]","relatedTo":"[redacted]"}',
        tool_result: "[redacted]",
        tool_is_error: false,
      });
      assertStrictEquals(
        String(events[0]?.content),
        `{"outcome":"created","externalMcp":{"server":"linear","tool":"${upstreamTool}","revision":"2026-07-28","identifier":"SYN-101"}}`,
      );
      assertFalse(JSON.stringify(events[0]).includes("must not persist"));
      assertFalse(JSON.stringify(events[0]).includes("Synthetic description"));
      assertFalse(JSON.stringify(events[0]).includes("fixture-token"));
    });

    it("a denied approval never calls the connector", async () => {
      const call = callSpy();
      const approve = approvalSpy("deny");
      const { result, events } = await invoke(
        call,
        invocationArguments(),
        approve,
      );
      assertObjectMatch(result as unknown as Record<string, unknown>, {
        decision: "deny",
        authzBasis: "policy:deny:approval-denied",
        isError: true,
      });
      assertSpyCalls(approve, 1);
      assertSpyCalls(call, 0);
      assertStringIncludes(String(events[0]?.content), '"outcome":"error"');
      assertFalse(String(events[0]?.content).includes('"identifier"'));
      assertStrictEquals(events[0]?.tool_is_error, true);
    });

    for (const [_name, override] of invalidArgumentCases) {
      it(`rejects ${String(_name)} without an external call`, async () => {
        const call = callSpy();
        const { result, approve } = await invoke(
          call,
          invocationArguments(override),
        );
        assertSpyCalls(approve, _name === "duplicate relations" ? 1 : 0);
        assertObjectMatch(result as unknown as Record<string, unknown>, {
          isError: true,
        });
        assertSpyCalls(call, 0);
      });
    }

    it("rejects oversized relations before reading items or asking approval", async () => {
      const relatedTo = Array(11).fill("SYN-1");
      const readItem = spy(() => {
        throw new Error("item must not be read");
      });
      Object.defineProperty(relatedTo, "0", { get: readItem });
      const call = callSpy();
      const { result, approve } = await invoke(
        call,
        invocationArguments({ relatedTo }),
      );
      assertObjectMatch(result as unknown as Record<string, unknown>, {
        isError: true,
        authzBasis: "policy:deny:invalid-arguments",
      });
      assertSpyCalls(readItem, 0);
      assertSpyCalls(approve, 0);
      assertSpyCalls(call, 0);
    });

    it("accepts ten distinct relations", async () => {
      const relatedTo = Array.from({ length: 10 }, (_, i) => `SYN-${i + 1}`);
      const call = callSpy(async () => successResult());
      const { result, approve } = await invoke(
        call,
        invocationArguments({ relatedTo }),
      );
      assertStrictEquals(result.isError, false);
      assertSpyCalls(approve, 1);
      assertSpyCalls(call, 1);
      assertEquals(call.calls[0].args[0].arguments.relatedTo, relatedTo);
    });

    for (
      const extra of [
        {
          team_id: binding.teamId,
          project_id: binding.projects["Synthetic Project"],
          team: { id: binding.teamId },
          project: { id: binding.projects["Synthetic Project"] },
        },
        { team: "Display team", project: "Display project" },
      ]
    ) {
      it(`accepts consistent ID evidence and display labels: ${JSON.stringify(extra)}`, () => {
        assertEquals(
          projectLinearIssueCreationReceipt(
            {
              structuredContent: {
                identifier: "SYN-108",
                teamId: binding.teamId,
                projectId: binding.projects["Synthetic Project"],
                ...extra,
              },
            },
            binding.teamId,
            binding.projects["Synthetic Project"],
          ),
          { identifier: "SYN-108" },
        );
      });
    }

    for (const malformed of [null, 42, false, [], {}, undefined]) {
      it(`rejects malformed explicit association IDs: ${JSON.stringify(malformed)}`, async () => {
        for (
          const key of [
            "teamId",
            "team_id",
            "projectId",
            "project_id",
            "team",
            "project",
          ]
        ) {
          const call = callSpy(async () => ({
            structuredContent: {
              identifier: "SYN-108",
              teamId: binding.teamId,
              projectId: binding.projects["Synthetic Project"],
              team: { id: binding.teamId },
              project: { id: binding.projects["Synthetic Project"] },
              [key]: key === "team" || key === "project"
                ? { id: malformed }
                : malformed,
            },
          }));
          const { result, events } = await invoke(call);
          assertObjectMatch(result as unknown as Record<string, unknown>, {
            isError: true,
            reason: INDETERMINATE,
          });
          assertSpyCalls(call, 1);
          assertFalse(String(events[0]?.content).includes('"identifier"'));
        }
      });
    }

    it("accepts issue-style id and display labels while retaining only the identifier", async () => {
      const call = spy(async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            id: "SYN-105",
            uuid: "issue_fixture",
            title: "discarded title",
            teamId: binding.teamId,
            team: "Synthetic Team",
            projectId: binding.projects["Synthetic Project"],
            project: "Synthetic Project",
          }),
        }],
      }));
      const { result, events, approve } = await invoke(call);
      assertObjectMatch(result as unknown as Record<string, unknown>, {
        isError: false,
        result: "SYN-105",
      });
      assertSpyCalls(call, 1);
      assertSpyCalls(approve, 1);
      assertStringIncludes(JSON.stringify(events), "SYN-105");
      assertFalse(JSON.stringify(events).includes("discarded title"));
      assertFalse(JSON.stringify(events).includes("issue_fixture"));
    });

    for (
      const override of [
        { id: "issue_uuid" },
        { id: "SYN-106", identifier: "SYN-107" },
        { id: "SYN-106", identifier: null },
        { id: "SYN-106", teamId: "wrong_team" },
        { id: "SYN-106", projectId: "wrong_project" },
        { id: "SYN-106", team: { id: "wrong_team" } },
      ]
    ) {
      it(`rejects invalid alias or association evidence without retry: ${JSON.stringify(override)}`, async () => {
        const call = spy(async () => ({
          structuredContent: {
            teamId: binding.teamId,
            team: "Synthetic Team",
            projectId: binding.projects["Synthetic Project"],
            project: "Synthetic Project",
            ...override,
          },
        }));
        const { result } = await invoke(call);
        assertObjectMatch(result as unknown as Record<string, unknown>, {
          isError: true,
          reason: INDETERMINATE,
        });
        assertSpyCalls(call, 1);
      });
    }

    for (const association of ["team", "project"] as const) {
      it(`rejects a ${String(association)} display label without an explicit ID`, async () => {
        const response: Record<string, unknown> = {
          identifier: "SYN-109",
          teamId: binding.teamId,
          team: "Synthetic Team",
          projectId: binding.projects["Synthetic Project"],
          project: "Synthetic Project",
        };
        delete response[`${association}Id`];
        assertStrictEquals(Object.hasOwn(response, `${association}Id`), false);
        assertStrictEquals(Object.hasOwn(response, `${association}_id`), false);
        const call = callSpy(async () => ({
          structuredContent: response,
        }));
        const { result, events } = await invoke(call);
        assertObjectMatch(result as unknown as Record<string, unknown>, {
          isError: true,
          reason: INDETERMINATE,
        });
        assertSpyCalls(call, 1);
        assertFalse(String(events[0]?.content).includes('"identifier"'));
      });
    }

    for (const [_name, behavior] of indeterminateCases) {
      it(`reports ${String(_name)} as indeterminate without replay`, async () => {
        const call = spy(behavior);
        const { result, events } = await invoke(call);
        assertEquals(result, {
          decision: "allow",
          authzBasis: "policy:allow:operator-approved",
          isError: true,
          reason:
            "Linear issue creation is indeterminate; reconcile in Linear before retrying.",
        });
        assertSpyCalls(call, 1);
        assertStringIncludes(String(events[0]?.content), '"outcome":"error"');
        assertFalse(JSON.stringify(result).includes("untrusted details"));
        assertStrictEquals(
          events[0]?.tool_result,
          "Linear issue creation is indeterminate; reconcile in Linear before retrying.",
        );
        assertFalse(String(events[0]?.content).includes('"identifier"'));
        for (
          const value of [
            "untrusted details",
            "Synthetic description",
            "fixture-token",
            "different_team",
            "different_project",
          ]
        ) {
          assertFalse(JSON.stringify(events).includes(value));
        }
      });
    }
  });
}

describe("Linear identifier receipt projection", () => {
  it("accepts structured evidence and returns only the identifier", () => {
    assertEquals(
      projectLinearIssueCreationReceipt(
        {
          structuredContent: {
            issue: {
              identifier: "SYN-104",
              team_id: binding.teamId,
              project_id: binding.projects["Synthetic Project"],
              title: "discarded",
            },
          },
        },
        binding.teamId,
        binding.projects["Synthetic Project"],
      ),
      {
        identifier: "SYN-104",
      },
    );
  });
});

describe("creation-only upstream schema projection", () => {
  for (
    const kind of ["cycle", "throwing serializer", "undefined serialization"]
  ) {
    it(`withholds a schema with ${String(kind)}`, () => {
      const schema: Record<string, unknown> = { ...saveIssueSchema };
      if (kind === "cycle") schema.properties = { optional: schema };
      else {schema.toJSON = () => {
          if (kind === "throwing serializer") {
            throw new Error("untrusted details");
          }
          return undefined;
        };}
      assertStrictEquals(
        projectLinearCreationUpstreamSchema(schema, binding),
        undefined,
      );
    });
  }

  it("accepts the live save schema without exposing update fields or nullable inputs", () => {
    const projected = projectLinearCreationUpstreamSchema(
      saveIssueSchema,
      binding,
    );
    assertEquals(projected?.properties?.project, { type: "string" });
    assertEquals(Object.keys(projected?.properties ?? {}), [
      "title",
      "description",
      "team",
      "project",
      "priority",
      "relatedTo",
    ]);
    assertStrictEquals(projected?.additionalProperties, false);
  });
  for (
    const override of [
      { required: ["id"] },
      { required: ["patch"] },
      { required: ["relatedTo"] },
      { required: [1] },
      { allOf: [] },
      { additionalProperties: { type: "string" } },
      {
        properties: {
          ...saveIssueSchema.properties,
          project: { type: "number" },
        },
      },
      {
        properties: {
          ...saveIssueSchema.properties,
          title: { type: "string", minLength: 5 },
        },
      },
      {
        properties: {
          ...saveIssueSchema.properties,
          project: { type: "string", enum: ["not configured"] },
        },
      },
      {
        properties: {
          ...saveIssueSchema.properties,
          relatedTo: {
            type: "array",
            items: { type: "string", enum: ["SYN-1"] },
          },
        },
      },
      {
        properties: {
          ...saveIssueSchema.properties,
          team: { $ref: "#/definitions/team" },
        },
      },
    ]
  ) {
    it(`withholds unsupported constraints ${JSON.stringify(override)}`, () => {
      assertStrictEquals(
        projectLinearCreationUpstreamSchema(
          { ...saveIssueSchema, ...override },
          binding,
        ),
        undefined,
      );
    });
  }
});
