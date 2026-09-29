import { describe, it } from "@std/testing/bdd";
import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCallArgs, assertSpyCalls, spy } from "@std/testing/mock";
import type { CommandDefinition } from "../../tools/mod.ts";
import {
  FrictionStageError,
  MAX_COMMENT_PAGES,
  postFriction,
} from "./friction.ts";
import { formatUntrustedMcpResult } from "../../tools/mcp/transport.ts";

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

// A Linear invoker fake that records its calls and resolves to nothing.
const invokerSpy = () =>
  spy((_arguments: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(undefined)
  );

describe("postFriction", () => {
  for (const issueIdentifier of [undefined, "   "]) {
    it(
      `requires the operator's friction-checkpoint issue before Linear calls (${
        JSON.stringify(issueIdentifier)
      })`,
      async () => {
        const getIssue = invokerSpy();
        const listComments = invokerSpy();
        const createComment = invokerSpy();

        assertObjectMatch(
          await assertRejects(() =>
            postFriction({
              issueIdentifier,
              request: { severity: "minor", escaped: false, text: "moment" },
              getIssueCommand,
              listCommentsCommand,
              createCommentCommand,
              invoke: { getIssue, listComments, createComment },
            }), Error) as unknown as Record<string, unknown>,
          {
            name: "FrictionStageError",
            stage: "configuration",
            message:
              "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
          } satisfies Partial<FrictionStageError>,
        );
        assertSpyCalls(getIssue, 0);
        assertSpyCalls(listComments, 0);
        assertSpyCalls(createComment, 0);
      },
    );
  }

  it("numbers across all existing comments and posts the ritual body", async () => {
    const createComment = spy(async (_arguments: Record<string, unknown>) =>
      framed({ id: "comment-39" })
    );
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

    assertEquals(result, {
      number: "F039",
      commentId: "comment-39",
      firstLine: "F039 · 2026-09-03 · minor · escaped? no",
    });
    assertSpyCallArgs(createComment, 0, [{
      issueId: "issue-uuid",
      body: [
        "F039 · 2026-09-03 · minor · escaped? no",
        "",
        "The one-line capture path required a second paste.",
        "",
        `Context: model=model-slug · workspace=example-repo · command=${truncatedSlashCommand}`,
      ].join("\n"),
    }]);
  });

  it("does not post free-text input from the command context field", async () => {
    let createdBody = "";
    const createComment = spy(
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

    assertSpyCalls(createComment, 1);
    assertEquals(createComment.calls[0]!.args[0].issueId, "issue-uuid");
    assertStringIncludes(
      String(createComment.calls[0]!.args[0].body),
      "Context: model=model-slug · workspace=example-repo",
    );
    assertFalse(createdBody.includes("private notes"));
    assertFalse(createdBody.includes("command="));
  });

  it("assigns independent next friction and escape numbers", async () => {
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

    assertEquals(result, {
      number: "F012",
      escapeNumber: "E004",
      commentId: "comment-12",
      firstLine: "F012 · E004 · 2026-09-03 · major · escaped? yes",
    });
  });

  it("labels an unreadable comments response without attempting a write", async () => {
    const createComment = invokerSpy();
    assertObjectMatch(
      await assertRejects(() =>
        postFriction({
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
        }), Error) as unknown as Record<string, unknown>,
      {
        name: "FrictionStageError",
        stage: "comment read",
      } satisfies Partial<FrictionStageError>,
    );
    assertSpyCalls(createComment, 0);
  });

  // The unwrap helper serves three callers, so an unreadable issue response must
  // report the stage that was running rather than the comment read that follows.
  for (
    const [label, response, publicReason] of [
      [
        "unreadable",
        "not json at all",
        "get_issue returned an unreadable response",
      ],
      ["non-object", framed(null), "get_issue response was not an object"],
    ]
  ) {
    it(`stages a ${label} get_issue response as the issue read`, async () => {
      const createComment = invokerSpy();
      assertObjectMatch(
        await assertRejects(() =>
          postFriction({
            issueIdentifier: "EX-100",
            request: { severity: "minor", escaped: false, text: "moment" },
            getIssueCommand,
            listCommentsCommand,
            createCommentCommand,
            invoke: {
              getIssue: async () => response,
              listComments: commentsPage(),
              createComment,
            },
          }), Error) as unknown as Record<string, unknown>,
        {
          name: "FrictionStageError",
          stage: "get_issue",
          publicReason,
        } satisfies Partial<FrictionStageError>,
      );
      assertSpyCalls(createComment, 0);
    });
  }

  // Comments are read from list_comments alone, so a body the parser cannot
  // read must name that tool and not the issue read that precedes it.
  it("names list_comments when a comment carries no readable text", async () => {
    const createComment = invokerSpy();
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "list_comments returned a comment without readable text",
    );
    assertSpyCalls(createComment, 0);
  });

  it("labels a get_issue failure without attempting a write", async () => {
    const createComment = invokerSpy();
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "get_issue failed: fixture read refused",
    );
    assertSpyCalls(createComment, 0);
  });

  it("labels a create failure and returns no false receipt", async () => {
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "create_comment failed: fixture write refused",
    );
  });

  it("accepts save_comment as the upstream comment tool", async () => {
    const createComment = spy(async (_arguments: Record<string, unknown>) =>
      framed({ id: "comment-42" })
    );
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

    assertStrictEquals(result.commentId, "comment-42");
    assertSpyCalls(createComment, 1);
    assertEquals(createComment.calls[0]!.args[0].issueId, "issue-uuid");
    assertStringIncludes(
      String(createComment.calls[0]!.args[0].body),
      "Saved via alternate tool.",
    );
  });
});

describe("paged comment reading", () => {
  it("numbers from the highest F-number on a later page", async () => {
    const createComment = spy(async (_arguments: Record<string, unknown>) =>
      framed({ id: "comment-44" })
    );
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
    assertStrictEquals(result.number, "F044");
    assertEquals(seen, [
      { issueId: "EX-100", limit: 10 },
      { issueId: "EX-100", limit: 10, cursor: "cursor-2" },
    ]);
  });

  it("refuses to number when another page is promised without a cursor", async () => {
    const createComment = invokerSpy();
    await assertRejects(
      () =>
        postFriction({
          issueIdentifier: "EX-100",
          request: { severity: "minor", escaped: false, text: "moment" },
          getIssueCommand,
          listCommentsCommand,
          createCommentCommand,
          invoke: {
            getIssue: async () => framed({ id: "issue-uuid" }),
            listComments: async () =>
              framed({
                comments: [{ body: "F041 · page" }],
                hasNextPage: true,
              }),
            createComment,
          },
        }),
      Error,
      "comment read failed: list_comments reported another page without a cursor",
    );
    assertSpyCalls(createComment, 0);
  });

  it("refuses to number when paging exceeds its bound", async () => {
    const createComment = invokerSpy();
    let calls = 0;
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      `comment read failed: list_comments did not finish within ${MAX_COMMENT_PAGES} pages`,
    );
    assertStrictEquals(calls, MAX_COMMENT_PAGES);
    assertSpyCalls(createComment, 0);
  });

  it("names a truncated page instead of calling it unreadable", async () => {
    const createComment = invokerSpy();
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "comment read failed: list_comments returned more than the tool-result ceiling allows",
    );
    // The marker lands inside the frame, before the closing tag: a check
    // against the end of the whole string would miss it.
    assertSpyCalls(createComment, 0);
  });

  it("follows continuation carried in a nodes container's pageInfo", async () => {
    const createComment = spy(async (_arguments: Record<string, unknown>) =>
      framed({ id: "comment-44" })
    );
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
    assertStrictEquals(result.number, "F044");
    assertObjectMatch(seen[1] as unknown as Record<string, unknown>, {
      cursor: "cursor-2",
    });
  });

  it("refuses when pages remain but the tool accepts no cursor", async () => {
    const createComment = invokerSpy();
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
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "comment read failed: list_comments has more pages but the configured tool declares no cursor argument",
    );
    // Refused on the first continuation rather than refetching to the bound.
    assertStrictEquals(calls, 1);
    assertSpyCalls(createComment, 0);
  });

  it("labels a list_comments failure without attempting a write", async () => {
    const createComment = invokerSpy();
    await assertRejects(
      () =>
        postFriction({
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
        }),
      Error,
      "comment read failed: fixture list refused",
    );
    assertSpyCalls(createComment, 0);
  });
});
