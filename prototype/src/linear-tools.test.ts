import { describe, expect, test, vi } from "vitest";
import saveIssueSchema from "./linear-save-issue-schema.fixture.ts";
import type {
  LinearIssueCreationBinding,
  McpHttpServerConfig,
} from "./config.ts";
import {
  type ConfirmToolApproval,
  createCommandRegistry,
  invokeCommandWithEvent,
  type JsonSchemaObject,
} from "./commands.ts";
import {
  boundedLinearCreateIssueSchema,
  buildBoundedLinearCreateIssueCommand,
  type LinearCreationUpstreamTool,
  type LinearIssueMcpCall,
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
  approve: ConfirmToolApproval = vi.fn(async () => ({
    decision: "approve" as const,
  })),
  upstreamTool: LinearCreationUpstreamTool = "create_issue",
) {
  const events: Record<string, unknown>[] = [];
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
        events.push(event as Record<string, unknown>);
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

describe.each(["create_issue", "save_issue"] as const)(
  "bounded Linear creation via %s",
  (upstreamTool) => {
    const invoke = (
      call: LinearIssueMcpCall,
      args?: Record<string, unknown>,
      approve?: ConfirmToolApproval,
    ) => invokeWith(call, args, approve, upstreamTool);
    test("projects only bounded model fields and exact configured project names", () => {
      const schema = boundedLinearCreateIssueSchema(binding);
      expect(Object.keys(schema.properties ?? {})).toEqual([
        "title",
        "description",
        "project",
        "priority",
        "relatedTo",
      ]);
      expect(schema.properties?.project?.enum).toEqual([
        "Synthetic Project",
        "Second Project",
      ]);
      expect(schema.properties).not.toHaveProperty("team");
      expect(schema.additionalProperties).toBe(false);
    });

    test("requires the discovered connector to accept every mapped field", () => {
      expect(supportsBoundedLinearCreateIssue(upstreamSchema, binding)).toBe(
        true,
      );
      expect(supportsBoundedLinearCreateIssue({
        ...upstreamSchema,
        properties: {
          ...upstreamSchema.properties,
          relatedTo: { type: "string" },
        },
      }, binding)).toBe(false);
      expect(supportsBoundedLinearCreateIssue({
        ...upstreamSchema,
        required: ["title", "unsupportedRequiredField"],
      }, binding)).toBe(false);
      expect(supportsBoundedLinearCreateIssue({
        ...upstreamSchema,
        required: ["title", "relatedTo"],
      }, binding)).toBe(false);
      expect(supportsBoundedLinearCreateIssue({
        ...upstreamSchema,
        properties: {
          ...upstreamSchema.properties,
          team: { type: "string", enum: ["different_team"] },
        },
      }, binding)).toBe(false);
    });

    test("injects configured IDs, asks once, calls once, and persists only the identifier", async () => {
      const call = vi.fn<LinearIssueMcpCall>(async () => successResult());
      const { result, events, approve } = await invoke(call);

      expect(approve).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0][0].tool).toBe(upstreamTool);
      expect(call.mock.calls[0][0].arguments).not.toHaveProperty("id");
      expect(call.mock.calls[0][0].arguments).not.toHaveProperty("patch");
      expect(call.mock.calls[0][0].arguments).toEqual({
        title: "Synthetic issue",
        description: "Synthetic description",
        team: "team_fixture_01",
        project: "project_fixture_01",
        priority: 2,
        relatedTo: ["SYN-7"],
      });
      expect(result).toEqual({
        decision: "allow",
        authzBasis: "policy:allow:operator-approved",
        isError: false,
        result: "SYN-101",
      });
      expect(events[0]).toMatchObject({
        tool_arguments:
          '{"title":"[redacted]","description":"[redacted]","project":"[redacted]","priority":"[redacted]","relatedTo":"[redacted]"}',
        tool_result: "[redacted]",
        tool_is_error: false,
      });
      expect(events[0].content).toBe(
        `{"outcome":"created","externalMcp":{"server":"linear","tool":"${upstreamTool}","revision":"2026-07-28","identifier":"SYN-101"}}`,
      );
      expect(JSON.stringify(events[0])).not.toContain("must not persist");
      expect(JSON.stringify(events[0])).not.toContain("Synthetic description");
      expect(JSON.stringify(events[0])).not.toContain("fixture-token");
    });

    test("a denied approval never calls the connector", async () => {
      const call = vi.fn<LinearIssueMcpCall>();
      const approve = vi.fn(async () => ({ decision: "deny" as const }));
      const { result, events } = await invoke(
        call,
        invocationArguments(),
        approve,
      );
      expect(result).toMatchObject({
        decision: "deny",
        authzBasis: "policy:deny:approval-denied",
        isError: true,
      });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(call).not.toHaveBeenCalled();
      expect(events[0].content).toContain('"outcome":"error"');
      expect(events[0].content).not.toContain('"identifier"');
      expect(events[0].tool_is_error).toBe(true);
    });

    test.each(invalidArgumentCases)(
      "rejects %s without an external call",
      async (_name, override) => {
        const call = vi.fn<LinearIssueMcpCall>();
        const { result, approve } = await invoke(
          call,
          invocationArguments(override),
        );
        expect(approve).toHaveBeenCalledTimes(
          _name === "duplicate relations" ? 1 : 0,
        );
        expect(result).toMatchObject({ isError: true });
        expect(call).not.toHaveBeenCalled();
      },
    );

    test("rejects oversized relations before reading items or asking approval", async () => {
      const relatedTo = Array(11).fill("SYN-1");
      const readItem = vi.fn(() => {
        throw new Error("item must not be read");
      });
      Object.defineProperty(relatedTo, "0", { get: readItem });
      const call = vi.fn<LinearIssueMcpCall>();
      const { result, approve } = await invoke(
        call,
        invocationArguments({ relatedTo }),
      );
      expect(result).toMatchObject({
        isError: true,
        authzBasis: "policy:deny:invalid-arguments",
      });
      expect(readItem).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });

    test("accepts ten distinct relations", async () => {
      const relatedTo = Array.from({ length: 10 }, (_, i) => `SYN-${i + 1}`);
      const call = vi.fn<LinearIssueMcpCall>(async () => successResult());
      const { result, approve } = await invoke(
        call,
        invocationArguments({ relatedTo }),
      );
      expect(result.isError).toBe(false);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0][0].arguments.relatedTo).toEqual(relatedTo);
    });

    test.each([
      {
        team_id: binding.teamId,
        project_id: binding.projects["Synthetic Project"],
        team: { id: binding.teamId },
        project: { id: binding.projects["Synthetic Project"] },
      },
      { team: "Display team", project: "Display project" },
    ])("accepts consistent ID evidence and display labels: %j", (extra) => {
      expect(projectLinearIssueCreationReceipt(
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
      )).toEqual({ identifier: "SYN-108" });
    });

    test.each([null, 42, false, [], {}, undefined])(
      "rejects malformed explicit association IDs: %j",
      async (malformed) => {
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
          const call = vi.fn<LinearIssueMcpCall>(async () => ({
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
          expect(result).toMatchObject({
            isError: true,
            reason: expect.stringContaining("indeterminate"),
          });
          expect(call).toHaveBeenCalledTimes(1);
          expect(events[0].content).not.toContain('"identifier"');
        }
      },
    );

    test("accepts issue-style id and display labels while retaining only the identifier", async () => {
      const call = vi.fn(async () => ({
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
      expect(result).toMatchObject({ isError: false, result: "SYN-105" });
      expect(call).toHaveBeenCalledTimes(1);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(events)).toContain("SYN-105");
      expect(JSON.stringify(events)).not.toContain("discarded title");
      expect(JSON.stringify(events)).not.toContain("issue_fixture");
    });

    test.each([
      { id: "issue_uuid" },
      { id: "SYN-106", identifier: "SYN-107" },
      { id: "SYN-106", identifier: null },
      { id: "SYN-106", teamId: "wrong_team" },
      { id: "SYN-106", projectId: "wrong_project" },
      { id: "SYN-106", team: { id: "wrong_team" } },
    ])(
      "rejects invalid alias or association evidence without retry: %j",
      async (override) => {
        const call = vi.fn(async () => ({
          structuredContent: {
            teamId: binding.teamId,
            team: "Synthetic Team",
            projectId: binding.projects["Synthetic Project"],
            project: "Synthetic Project",
            ...override,
          },
        }));
        const { result } = await invoke(call);
        expect(result).toMatchObject({
          isError: true,
          reason: expect.stringContaining("indeterminate"),
        });
        expect(call).toHaveBeenCalledTimes(1);
      },
    );

    test.each(["team", "project"] as const)(
      "rejects a %s display label without an explicit ID",
      async (association) => {
        const response: Record<string, unknown> = {
          identifier: "SYN-109",
          teamId: binding.teamId,
          team: "Synthetic Team",
          projectId: binding.projects["Synthetic Project"],
          project: "Synthetic Project",
        };
        delete response[`${association}Id`];
        expect(Object.hasOwn(response, `${association}Id`)).toBe(false);
        expect(Object.hasOwn(response, `${association}_id`)).toBe(false);
        const call = vi.fn<LinearIssueMcpCall>(async () => ({
          structuredContent: response,
        }));
        const { result, events } = await invoke(call);
        expect(result).toMatchObject({
          isError: true,
          reason: expect.stringContaining("indeterminate"),
        });
        expect(call).toHaveBeenCalledTimes(1);
        expect(events[0].content).not.toContain('"identifier"');
      },
    );

    test.each(indeterminateCases)(
      "reports %s as indeterminate without replay",
      async (_name, behavior) => {
        const call = vi.fn(behavior);
        const { result, events } = await invoke(call);
        expect(result).toEqual({
          decision: "allow",
          authzBasis: "policy:allow:operator-approved",
          isError: true,
          reason:
            "Linear issue creation is indeterminate; reconcile in Linear before retrying.",
        });
        expect(call).toHaveBeenCalledTimes(1);
        expect(events[0].content).toContain('"outcome":"error"');
        expect(JSON.stringify(result)).not.toContain("untrusted details");
        expect(events[0].tool_result).toBe(
          "Linear issue creation is indeterminate; reconcile in Linear before retrying.",
        );
        expect(events[0].content).not.toContain('"identifier"');
        for (
          const value of [
            "untrusted details",
            "Synthetic description",
            "fixture-token",
            "different_team",
            "different_project",
          ]
        ) {
          expect(JSON.stringify(events)).not.toContain(value);
        }
      },
    );
  },
);

describe("Linear identifier receipt projection", () => {
  test("accepts structured evidence and returns only the identifier", () => {
    expect(projectLinearIssueCreationReceipt(
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
    )).toEqual({
      identifier: "SYN-104",
    });
  });
});

describe("creation-only upstream schema projection", () => {
  test("accepts the live save schema without exposing update fields or nullable inputs", () => {
    const projected = projectLinearCreationUpstreamSchema(
      saveIssueSchema,
      binding,
    );
    expect(projected?.properties?.project).toEqual({ type: "string" });
    expect(Object.keys(projected?.properties ?? {})).toEqual([
      "title",
      "description",
      "team",
      "project",
      "priority",
      "relatedTo",
    ]);
    expect(projected?.additionalProperties).toBe(false);
  });
  test.each([
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
  ])("withholds unsupported constraints %j", (override) => {
    expect(
      projectLinearCreationUpstreamSchema(
        { ...saveIssueSchema, ...override },
        binding,
      ),
    ).toBeUndefined();
  });
});
