import { describe, expect, test, vi } from "vitest";
import type { CommandDefinition } from "./commands.ts";
import { FrictionStageError, postFriction } from "./friction.ts";
import { formatUntrustedMcpResult } from "./mcp-tools.ts";

const getIssueCommand: CommandDefinition = {
  id: "mcp.linear.get_issue",
  title: "Get issue",
  description: "Fixture Linear read",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  permission: {
    effects: ["read.external"],
    defaultDecision: "allow",
    resources: ["mcp:linear/get_issue"],
  },
  executor: () => "unused",
};

const createCommentCommand: CommandDefinition = {
  id: "mcp.linear.create_comment",
  title: "Create comment",
  description: "Fixture Linear write",
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
    effects: ["write.external"],
    defaultDecision: "ask",
    resources: ["mcp:linear/create_comment"],
  },
  executor: () => "unused",
};

function framed(value: unknown): string {
  return formatUntrustedMcpResult(JSON.stringify(value));
}

describe("postFriction", () => {
  test.each([undefined, "   "])(
    "requires the operator's friction-checkpoint issue before Linear calls",
    async (issueIdentifier) => {
      const getIssue = vi.fn();
      const createComment = vi.fn();

      await expect(postFriction({
        issueIdentifier,
        request: { severity: "minor", escaped: false, text: "moment" },
        getIssueCommand,
        createCommentCommand,
        invoke: { getIssue, createComment },
      })).rejects.toMatchObject(
        {
          name: "FrictionStageError",
          stage: "configuration",
          message:
            "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
        } satisfies Partial<FrictionStageError>,
      );
      expect(getIssue).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  test("numbers across all existing comments and posts the ritual body", async () => {
    const createComment = vi.fn(async () => framed({ id: "comment-39" }));
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: {
        severity: "minor",
        escaped: false,
        text: "The one-line capture path required a second paste.",
        context: {
          model: "model-slug",
          workspace: "/workspace",
          command: "/packet draft",
        },
      },
      getIssueCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () =>
          framed({
            id: "issue-uuid",
            comments: [
              { body: "F004 · earlier" },
              { body: "discussion mentions F038 and F012" },
            ],
          }),
        createComment,
      },
      now: () => new Date(2026, 8, 3, 12),
    });

    expect(result).toEqual({
      number: "F039",
      commentId: "comment-39",
      firstLine: "F039 · 2026-09-03 · minor · escaped? no",
    });
    expect(createComment).toHaveBeenCalledWith({
      issueId: "issue-uuid",
      body: [
        "F039 · 2026-09-03 · minor · escaped? no",
        "",
        "The one-line capture path required a second paste.",
        "",
        "Context: model=model-slug · workspace=/workspace · command=/packet draft",
      ].join("\n"),
    });
  });

  test("assigns independent next friction and escape numbers", async () => {
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: {
        severity: "major",
        escaped: true,
        text: "Recovered through the alternate path.",
      },
      getIssueCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () =>
          framed({
            comments: [
              { body: "F009 · E003 · old escape" },
              { body: "F011 · ordinary friction" },
            ],
          }),
        createComment: async () => framed({ comment: { id: "comment-12" } }),
      },
      now: () => new Date(2026, 8, 3, 12),
    });

    expect(result).toEqual({
      number: "F012",
      escapeNumber: "E004",
      commentId: "comment-12",
      firstLine: "F012 · E004 · 2026-09-03 · major · escaped? yes",
    });
  });

  test("labels an unreadable comments response without attempting a write", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        createComment,
      },
    })).rejects.toEqual(expect.objectContaining(
      {
        name: "FrictionStageError",
        stage: "comment read",
      } satisfies Partial<FrictionStageError>,
    ));
    expect(createComment).not.toHaveBeenCalled();
  });

  test("labels a get_issue failure without attempting a write", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => {
          throw new Error("fixture read refused");
        },
        createComment,
      },
    })).rejects.toThrow("get_issue failed: fixture read refused");
    expect(createComment).not.toHaveBeenCalled();
  });

  test("labels a create failure and returns no false receipt", async () => {
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ comments: [] }),
        createComment: async () => {
          throw new Error("fixture write refused");
        },
      },
    })).rejects.toThrow("create_comment failed: fixture write refused");
  });
});
