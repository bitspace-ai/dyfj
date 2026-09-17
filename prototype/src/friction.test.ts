import { describe, expect, test, vi } from "vitest";
import type { CommandDefinition } from "./commands.ts";
import {
  FrictionStageError,
  isLinearCommentCommandId,
  MAX_COMMENT_PAGES,
  postFriction,
} from "./friction.ts";
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

const saveCommentCommand: CommandDefinition = {
  id: "mcp.linear.save_comment",
  title: "Save comment",
  description: "Fixture Linear write via save_comment",
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
    resources: ["mcp:linear/save_comment"],
  },
  executor: () => "unused",
};

function framed(value: unknown): string {
  return formatUntrustedMcpResult(JSON.stringify(value));
}

const listCommentsCommand: CommandDefinition = {
  id: "mcp.linear.list_comments",
  title: "List comments",
  description: "Fixture Linear paged comment read",
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
    effects: ["read.external"],
    defaultDecision: "allow",
    resources: ["mcp:linear/list_comments"],
  },
  executor: () => "unused",
};

/** One page, no continuation — the shape most tests need. */
const commentsPage = (bodies: readonly string[] = []) => async () =>
  framed({ comments: bodies.map((body) => ({ body })), hasNextPage: false });

describe("postFriction", () => {
  test.each([undefined, "   "])(
    "requires the operator's friction-checkpoint issue before Linear calls",
    async (issueIdentifier) => {
      const getIssue = vi.fn();
      const listComments = vi.fn();
      const createComment = vi.fn();

      await expect(postFriction({
        issueIdentifier,
        request: { severity: "minor", escaped: false, text: "moment" },
        getIssueCommand,
        listCommentsCommand,
        createCommentCommand,
        invoke: { getIssue, listComments, createComment },
      })).rejects.toMatchObject(
        {
          name: "FrictionStageError",
          stage: "configuration",
          message:
            "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
        } satisfies Partial<FrictionStageError>,
      );
      expect(getIssue).not.toHaveBeenCalled();
      expect(listComments).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  test("numbers across all existing comments and posts the ritual body", async () => {
    const createComment = vi.fn(async () => framed({ id: "comment-39" }));
    const previousSlashCommand = `/packet ${"x".repeat(200)}`;
    const truncatedSlashCommand = previousSlashCommand.slice(0, 119) + "…";
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: {
        severity: "minor",
        escaped: false,
        text: "The one-line capture path required a second paste.",
        context: {
          model: "model-slug",
          workspace: "/private/workspaces/example-repo",
          command: previousSlashCommand,
        },
      },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: commentsPage([
          "F004 · earlier",
          "discussion mentions F038 and F012",
        ]),
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
        `Context: model=model-slug · workspace=example-repo · command=${truncatedSlashCommand}`,
      ].join("\n"),
    });
  });

  test("does not post free-text input from the command context field", async () => {
    let createdBody = "";
    const createComment = vi.fn(
      async (arguments_: Record<string, unknown>) => {
        createdBody = String(arguments_.body);
        return framed({ id: "comment-1" });
      },
    );
    await postFriction({
      issueIdentifier: "EX-100",
      request: {
        severity: "minor",
        escaped: false,
        text: "A concrete operator moment.",
        context: {
          model: "model-slug",
          workspace: "/private/workspaces/example-repo",
          command: "Summarize the operator's private notes.",
        },
      },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: commentsPage(),
        createComment,
      },
    });

    expect(createComment).toHaveBeenCalledWith({
      issueId: "issue-uuid",
      body: expect.stringContaining(
        "Context: model=model-slug · workspace=example-repo",
      ),
    });
    expect(createdBody).not.toContain("private notes");
    expect(createdBody).not.toContain("command=");
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
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({}),
        listComments: commentsPage([
          "F009 · E003 · old escape",
          "F011 · ordinary friction",
        ]),
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
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () => framed({ unexpected: true }),
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

  // Comments are read from list_comments alone, so a body the parser cannot
  // read must name that tool and not the issue read that precedes it.
  test("names list_comments when a comment carries no readable text", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () =>
          framed({ comments: [{ author: "someone" }], hasNextPage: false }),
        createComment,
      },
    })).rejects.toThrow(
      "list_comments returned a comment without readable text",
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  test("labels a get_issue failure without attempting a write", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => {
          throw new Error("fixture read refused");
        },
        listComments: commentsPage(),
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
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({}),
        listComments: commentsPage(),
        createComment: async () => {
          throw new Error("fixture write refused");
        },
      },
    })).rejects.toThrow("create_comment failed: fixture write refused");
  });

  test("accepts save_comment as the upstream comment tool", async () => {
    const createComment = vi.fn(async () => framed({ id: "comment-42" }));
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: {
        severity: "minor",
        escaped: false,
        text: "Saved via alternate tool.",
      },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand: saveCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: commentsPage(),
        createComment,
      },
    });

    expect(result.commentId).toBe("comment-42");
    expect(createComment).toHaveBeenCalledWith({
      issueId: "issue-uuid",
      body: expect.stringContaining("Saved via alternate tool."),
    });
  });
});

describe("paged comment reading", () => {
  test("numbers from the highest F-number on a later page", async () => {
    const createComment = vi.fn(async () => framed({ id: "comment-44" }));
    const pages = [
      framed({
        comments: [
          { body: "F041 · first page" },
          { body: "F042 · first page" },
        ],
        hasNextPage: true,
        cursor: "cursor-2",
      }),
      framed({
        comments: [{ body: "F043 · only on the second page" }],
        hasNextPage: false,
      }),
    ];
    const seen: Array<Record<string, unknown>> = [];
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async (arguments_) => {
          seen.push(arguments_);
          return pages[seen.length - 1];
        },
        createComment,
      },
      now: () => new Date(2026, 8, 3, 12),
    });

    // A single-page read stops at F042 and returns F043 — a number that
    // already exists on the unread page.
    expect(result.number).toBe("F044");
    expect(seen).toEqual([
      { issueId: "EX-100", limit: 10 },
      { issueId: "EX-100", limit: 10, cursor: "cursor-2" },
    ]);
  });

  test("refuses to number when another page is promised without a cursor", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () =>
          framed({ comments: [{ body: "F041 · page" }], hasNextPage: true }),
        createComment,
      },
    })).rejects.toThrow(
      "comment read failed: list_comments reported another page without a cursor",
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  test("refuses to number when paging exceeds its bound", async () => {
    const createComment = vi.fn();
    let calls = 0;
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () => {
          calls += 1;
          return framed({
            comments: [{ body: `F0${calls} · page` }],
            hasNextPage: true,
            cursor: `cursor-${calls}`,
          });
        },
        createComment,
      },
    })).rejects.toThrow(
      `comment read failed: list_comments did not finish within ${MAX_COMMENT_PAGES} pages`,
    );
    expect(calls).toBe(MAX_COMMENT_PAGES);
    expect(createComment).not.toHaveBeenCalled();
  });

  test("names a truncated page instead of calling it unreadable", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        // Clipped by the real framing helper rather than hand-assembled: this
        // verifies detection of truncation as the current helper produces it,
        // which an imitation fixture did not.
        listComments: async () =>
          framed({
            comments: Array.from({ length: 40 }, (_unused, index) => ({
              body: `F0${index} · ${"long friction prose ".repeat(120)}`,
            })),
            hasNextPage: false,
          }),
        createComment,
      },
    })).rejects.toThrow(
      "comment read failed: list_comments returned more than the tool-result ceiling allows",
    );
    // The marker lands inside the frame, before the closing tag: a check
    // against the end of the whole string would miss it.
    expect(createComment).not.toHaveBeenCalled();
  });

  test("follows continuation carried in a nodes container's pageInfo", async () => {
    const createComment = vi.fn(async () => framed({ id: "comment-44" }));
    const pages = [
      framed({
        comments: {
          nodes: [{ body: "F041 · page one" }, { body: "F042 · page one" }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
        },
      }),
      framed({
        comments: {
          nodes: [{ body: "F043 · page two" }],
          pageInfo: { hasNextPage: false },
        },
      }),
    ];
    const seen: Array<Record<string, unknown>> = [];
    const result = await postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async (arguments_) => {
          seen.push(arguments_);
          return pages[seen.length - 1];
        },
        createComment,
      },
      now: () => new Date(2026, 8, 3, 12),
    });

    // Reading only top-level continuation metadata would stop after page one
    // and return F043, which page two already holds.
    expect(result.number).toBe("F044");
    expect(seen[1]).toMatchObject({ cursor: "cursor-2" });
  });

  test("refuses when pages remain but the tool accepts no cursor", async () => {
    const createComment = vi.fn();
    const cursorlessCommand: CommandDefinition = {
      ...listCommentsCommand,
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, limit: { type: "number" } },
        required: ["issueId"],
        additionalProperties: false,
      },
    };
    let calls = 0;
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand: cursorlessCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () => {
          calls += 1;
          return framed({
            comments: [{ body: "F041 · page" }],
            hasNextPage: true,
            cursor: "cursor-2",
          });
        },
        createComment,
      },
    })).rejects.toThrow(
      "comment read failed: list_comments has more pages but the configured tool declares no cursor argument",
    );
    // Refused on the first continuation rather than refetching to the bound.
    expect(calls).toBe(1);
    expect(createComment).not.toHaveBeenCalled();
  });

  test("labels a list_comments failure without attempting a write", async () => {
    const createComment = vi.fn();
    await expect(postFriction({
      issueIdentifier: "EX-100",
      request: { severity: "minor", escaped: false, text: "moment" },
      getIssueCommand,
      listCommentsCommand,
      createCommentCommand,
      invoke: {
        getIssue: async () => framed({ id: "issue-uuid" }),
        listComments: async () => {
          throw new Error("fixture list refused");
        },
        createComment,
      },
    })).rejects.toThrow("comment read failed: fixture list refused");
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe("isLinearCommentCommandId", () => {
  test.each([
    "mcp.linear.create_comment",
    "mcp.linear.save_comment",
  ])("accepts %s", (id) => {
    expect(isLinearCommentCommandId(id)).toBe(true);
  });

  test.each([
    "mcp.linear.get_issue",
    "mcp.other.save_comment",
    "save_comment",
  ])("rejects %s", (id) => {
    expect(isLinearCommentCommandId(id)).toBe(false);
  });
});
