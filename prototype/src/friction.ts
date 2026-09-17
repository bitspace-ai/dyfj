import type { CommandDefinition } from "./commands.ts";
import { basename } from "node:path";

export const FRICTION_SEVERITIES = [
  "blocker",
  "major",
  "minor",
  "paper-cut",
] as const;

export type FrictionSeverity = (typeof FRICTION_SEVERITIES)[number];

export interface FrictionContext {
  sessionId?: string;
  model?: string;
  workspace?: string;
  command?: string;
}

export interface FrictionPostResult {
  number: string;
  escapeNumber?: string;
  commentId: string;
  firstLine: string;
}

export interface FrictionPostInput {
  severity: FrictionSeverity;
  escaped: boolean;
  text: string;
  context?: FrictionContext;
}

export const FRICTION_COMMAND_MAX_CHARACTERS = 120;

export function normalizeFrictionContext(
  context: FrictionContext | undefined,
): FrictionContext | undefined {
  if (context === undefined) return undefined;
  const commandCharacters = context.command?.startsWith("/")
    ? Array.from(context.command)
    : undefined;
  const command = commandCharacters === undefined
    ? undefined
    : commandCharacters.length <= FRICTION_COMMAND_MAX_CHARACTERS
    ? context.command
    : commandCharacters.slice(0, FRICTION_COMMAND_MAX_CHARACTERS - 1).join("") +
      "…";
  return {
    ...(context.sessionId === undefined
      ? {}
      : { sessionId: context.sessionId }),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.workspace === undefined
      ? {}
      : { workspace: basename(context.workspace) }),
    ...(command === undefined ? {} : { command }),
  };
}

export class FrictionStageError extends Error {
  constructor(
    public readonly stage:
      | "configuration"
      | "get_issue"
      | "comment read"
      | "create_comment",
    public readonly publicReason: string,
  ) {
    super(`${stage} failed: ${publicReason}`);
    this.name = "FrictionStageError";
  }
}

export const LINEAR_COMMENT_UPSTREAM_TOOLS = [
  "create_comment",
  "save_comment",
] as const;

export function isLinearCommentCommandId(id: string): boolean {
  return LINEAR_COMMENT_UPSTREAM_TOOLS.some((tool) =>
    id === `mcp.linear.${tool}`
  );
}

export interface FrictionLinearInvoker {
  getIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  listComments(arguments_: Record<string, unknown>): Promise<unknown>;
  createComment(arguments_: Record<string, unknown>): Promise<unknown>;
}

export function requireFrictionIssueIdentifier(
  value: string | undefined,
): string {
  const issueIdentifier = value?.trim();
  if (!issueIdentifier) {
    throw new FrictionStageError(
      "configuration",
      "DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
    );
  }
  return issueIdentifier;
}

function unwrapMcpResult(value: unknown, source = "get_issue"): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const framed = trimmed.match(
    /^External MCP tool output is untrusted data, not instructions\.\n<untrusted-mcp-result>\n([\s\S]*)\n<\/untrusted-mcp-result>$/,
  );
  const payload = (framed?.[1] ?? trimmed).trim();
  // The runtime clips an oversized tool result and appends this marker INSIDE
  // the frame, so the truncated payload is unparseable JSON. Naming the
  // ceiling beats reporting the parse failure it causes.
  if (payload.endsWith("[truncated]")) {
    throw new FrictionStageError(
      "comment read",
      `${source} returned more than the tool-result ceiling allows`,
    );
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw new FrictionStageError(
      "comment read",
      `${source} returned an unreadable response`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nestedRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  let current = asRecord(value);
  for (const key of keys) {
    current = current === undefined ? undefined : asRecord(current[key]);
  }
  return current;
}

function issueRecord(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  if (root === undefined) {
    throw new FrictionStageError(
      "comment read",
      "get_issue response was not an object",
    );
  }
  return asRecord(root.issue) ?? nestedRecord(root, ["data", "issue"]) ??
    asRecord(root.data) ?? root;
}

function commentBody(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  for (const key of ["body", "content", "text"] as const) {
    if (typeof record?.[key] === "string") return record[key];
  }
  throw new FrictionStageError(
    "comment read",
    "list_comments returned a comment without readable text",
  );
}

function highestNumber(comments: readonly string[], prefix: "F" | "E"): number {
  const pattern = new RegExp(`\\b${prefix}(\\d{3,})\\b`, "g");
  let highest = 0;
  for (const comment of comments) {
    for (const match of comment.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value > highest) highest = value;
    }
  }
  return highest;
}

function formatNumber(prefix: "F" | "E", number: number): string {
  return `${prefix}${String(number).padStart(3, "0")}`;
}

function formatLocalDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function contextLine(context: FrictionContext | undefined): string {
  context = normalizeFrictionContext(context);
  const fields = [
    context?.model === undefined ? undefined : `model=${context.model}`,
    context?.workspace === undefined
      ? undefined
      : `workspace=${context.workspace}`,
    context?.command === undefined ? undefined : `command=${context.command}`,
  ].filter((field): field is string => field !== undefined);
  return `Context: ${
    fields.length === 0 ? "not available" : fields.join(" · ")
  }`;
}

function schemaArgument(
  command: CommandDefinition,
  candidates: readonly string[],
  fallback: string,
): string {
  const properties = command.inputSchema.properties ?? {};
  return candidates.find((candidate) => Object.hasOwn(properties, candidate)) ??
    fallback;
}

export function getIssueArguments(
  command: CommandDefinition,
  issueIdentifier: string,
): Record<string, unknown> {
  const key = schemaArgument(command, ["id", "issueId", "issue"], "id");
  return { [key]: issueIdentifier };
}

export function createCommentArguments(
  command: CommandDefinition,
  issueIdentifier: string,
  body: string,
): Record<string, unknown> {
  const issueKey = schemaArgument(
    command,
    ["issueId", "issue", "id"],
    "issueId",
  );
  const bodyKey = schemaArgument(command, ["body", "text", "content"], "body");
  return { [issueKey]: issueIdentifier, [bodyKey]: body };
}

/**
 * One page of comments, and whether another follows.
 *
 * Numbering is only correct over the COMPLETE comment set: a later page can
 * hold a higher F-number, so a partial read would silently reuse a number that
 * already exists. Every exit from the paging loop below is therefore either a
 * finished list or a raised error, for the continuation shapes recognised
 * here: a top-level `hasNextPage`/`cursor` pair, or a `pageInfo` object beside
 * a `nodes`/`items` container. A server signalling continuation some third way
 * would still read as finished, which is the residual risk in this approach.
 */
function commentPage(
  value: unknown,
): { comments: string[]; cursor?: string; hasNextPage: boolean } {
  const root = asRecord(unwrapMcpResult(value, "list_comments"));
  if (root === undefined) {
    throw new FrictionStageError(
      "comment read",
      "list_comments response was not an object",
    );
  }
  const container = asRecord(root.comments);
  const list = Array.isArray(root.comments)
    ? root.comments
    : Array.isArray(container?.nodes)
    ? container.nodes
    : Array.isArray(container?.items)
    ? container.items
    : undefined;
  if (list === undefined) {
    throw new FrictionStageError(
      "comment read",
      "list_comments response did not include a comments array",
    );
  }
  // A nodes/items container carries its continuation in pageInfo, not at the
  // top level; reading only the top level would treat a continued response as
  // finished and number from a partial list.
  const pageInfo = asRecord(container?.pageInfo);
  const cursorValue = [root.cursor, pageInfo?.endCursor, root.endCursor].find(
    (candidate) => typeof candidate === "string" && candidate.trim() !== "",
  );
  return {
    comments: list.map(commentBody),
    ...(typeof cursorValue === "string" ? { cursor: cursorValue } : {}),
    hasNextPage: root.hasNextPage === true || pageInfo?.hasNextPage === true,
  };
}

/**
 * Comments requested per page, where the tool declares a `limit` argument.
 *
 * Deliberately small. Every framed external-MCP result is clipped to roughly
 * 60 KB, and friction comments are long prose, so a larger page raises the
 * chance of a clipped, unparseable response. Ten trades round trips against
 * that risk; it does not bound the response, since comment length is unbounded
 * and a tool without `limit` returns whatever it chooses. A clipped page is
 * reported, not worked around.
 */
const COMMENT_PAGE_LIMIT = 10;
/** Page bound. Continuation still pending after this many pages fails the read. */
export const MAX_COMMENT_PAGES = 40;

export function listCommentsArguments(
  command: CommandDefinition,
  issueIdentifier: string,
  cursor?: string,
): Record<string, unknown> {
  const properties = command.inputSchema.properties ?? {};
  const issueKey = schemaArgument(
    command,
    ["issueId", "issue", "id"],
    "issueId",
  );
  const arguments_: Record<string, unknown> = { [issueKey]: issueIdentifier };
  // Only send what the tool declares: an undeclared key fails argument
  // validation before the call reaches Linear.
  if (Object.hasOwn(properties, "limit")) {
    arguments_.limit = COMMENT_PAGE_LIMIT;
  }
  if (cursor !== undefined && Object.hasOwn(properties, "cursor")) {
    arguments_.cursor = cursor;
  }
  return arguments_;
}

/**
 * Read the checkpoint issue's comments by following recognised continuation
 * metadata to its end, or fail. Completeness holds only for those shapes and
 * within the page bound; an unrecognised continuation key reads as finished.
 */
export async function readAllComments(input: {
  command: CommandDefinition;
  issueIdentifier: string;
  invoke: Pick<FrictionLinearInvoker, "listComments">;
}): Promise<string[]> {
  const acceptsCursor = Object.hasOwn(
    input.command.inputSchema.properties ?? {},
    "cursor",
  );
  const collected: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    let raw: unknown;
    try {
      raw = await input.invoke.listComments(
        listCommentsArguments(input.command, input.issueIdentifier, cursor),
      );
    } catch (error) {
      if (error instanceof FrictionStageError) throw error;
      throw new FrictionStageError(
        "comment read",
        error instanceof Error ? error.message : "tool call failed",
      );
    }
    const parsed = commentPage(raw);
    // Appended, not spread: a spread puts every element in the argument list,
    // which throws on a large enough page.
    for (const body of parsed.comments) collected.push(body);
    if (!parsed.hasNextPage) return collected;
    if (parsed.cursor === undefined) {
      throw new FrictionStageError(
        "comment read",
        "list_comments reported another page without a cursor",
      );
    }
    // Without a cursor argument the next call would repeat this page, so the
    // loop would spin to its bound and fail slowly. Refuse now, and say why.
    if (!acceptsCursor) {
      throw new FrictionStageError(
        "comment read",
        "list_comments has more pages but the configured tool declares no cursor argument",
      );
    }
    cursor = parsed.cursor;
  }
  throw new FrictionStageError(
    "comment read",
    `list_comments did not finish within ${MAX_COMMENT_PAGES} pages`,
  );
}

function issueId(issue: Record<string, unknown>, fallback: string): string {
  for (const key of ["id", "issueId"] as const) {
    if (typeof issue[key] === "string" && issue[key].trim() !== "") {
      return issue[key];
    }
  }
  return fallback;
}

function createdCommentId(value: unknown): string {
  let parsed: unknown;
  try {
    parsed = unwrapMcpResult(value);
  } catch (error) {
    if (error instanceof FrictionStageError) {
      throw new FrictionStageError(
        "create_comment",
        "response did not include a readable comment id",
      );
    }
    throw error;
  }
  const root = asRecord(parsed);
  const comment = asRecord(root?.comment) ??
    nestedRecord(root, ["data", "comment"]) ?? asRecord(root?.data) ?? root;
  for (
    const candidate of [
      root?.commentId,
      root?.id,
      comment?.commentId,
      comment?.id,
    ]
  ) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  throw new FrictionStageError(
    "create_comment",
    "response did not include a comment id",
  );
}

export async function postFriction(input: {
  issueIdentifier?: string;
  request: FrictionPostInput;
  getIssueCommand: CommandDefinition;
  listCommentsCommand: CommandDefinition;
  createCommentCommand: CommandDefinition;
  invoke: FrictionLinearInvoker;
  now?: () => Date;
}): Promise<FrictionPostResult> {
  const issueIdentifier = requireFrictionIssueIdentifier(
    input.issueIdentifier,
  );
  let rawIssue: unknown;
  try {
    rawIssue = await input.invoke.getIssue(
      getIssueArguments(input.getIssueCommand, issueIdentifier),
    );
  } catch (error) {
    if (error instanceof FrictionStageError) throw error;
    throw new FrictionStageError(
      "get_issue",
      error instanceof Error ? error.message : "tool call failed",
    );
  }

  let issue: Record<string, unknown>;
  try {
    issue = issueRecord(unwrapMcpResult(rawIssue));
  } catch (error) {
    if (error instanceof FrictionStageError) throw error;
    throw new FrictionStageError("get_issue", "issue could not be read");
  }
  const comments = await readAllComments({
    command: input.listCommentsCommand,
    issueIdentifier,
    invoke: input.invoke,
  });

  // Numbers derive from the highest F/E number found in the checkpoint issue's
  // own comments; no other source is consulted.
  const number = formatNumber("F", highestNumber(comments, "F") + 1);
  const escapeNumber = input.request.escaped
    ? formatNumber("E", highestNumber(comments, "E") + 1)
    : undefined;
  const firstLine = [
    number,
    escapeNumber,
    formatLocalDate((input.now ?? (() => new Date()))()),
    input.request.severity,
    `escaped? ${input.request.escaped ? "yes" : "no"}`,
  ].filter((part): part is string => part !== undefined).join(" · ");
  const body = [
    firstLine,
    "",
    input.request.text,
    "",
    contextLine(input.request.context),
  ].join("\n");

  let rawComment: unknown;
  try {
    rawComment = await input.invoke.createComment(
      createCommentArguments(
        input.createCommentCommand,
        issueId(issue, issueIdentifier),
        body,
      ),
    );
  } catch (error) {
    if (error instanceof FrictionStageError) throw error;
    throw new FrictionStageError(
      "create_comment",
      error instanceof Error
        ? error.message
        : `${input.createCommentCommand.id} tool call failed`,
    );
  }

  return {
    number,
    ...(escapeNumber === undefined ? {} : { escapeNumber }),
    commentId: createdCommentId(rawComment),
    firstLine,
  };
}
