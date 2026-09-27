/**
 * The declared gap: writes that have no event type yet.
 *
 * Every mutation the runtime or the memory MCP server makes goes through
 * `journal.commit`. An event append is the normal case. The writes below
 * change a table directly because no event type records them today; each
 * passes through `commit` as a typed `UnjournaledMutation`, and each kind is
 * listed here with the reason it has no event yet
 * (`specs/02-data-layer.md` section 2).
 *
 * This list may only shrink. `commit` rejects a kind that is not listed, and
 * the store conformance suite checks that. Durable-state work on the roadmap
 * empties it by adding event types (DDL first) and projectors.
 */

import type { MemoryType } from "./memories.ts";

export const UNJOURNALED_MUTATION_KINDS = {
  session_insert:
    "No event creates a session row. session_start is written on every turn, " +
    "resumes included, and carries only the prompt; the row is written later " +
    "in a new session's first turn, with workspace and context-source content " +
    "that no event carries. The memory MCP server's start_session inserts a " +
    "row with no event at all.",
  session_update:
    "No event type records a session's status, progress or content change. " +
    "session_end marks the turn's end but carries none of the row's fields, " +
    "and the memory MCP server's update_session writes no event.",
  memory_upsert:
    "No event type records a memory write. The memory MCP server's " +
    "write_memory upserts the row directly.",
} as const;

export type UnjournaledMutationKind = keyof typeof UNJOURNALED_MUTATION_KINDS;

/** Create a session row. Omitted row columns keep their DDL defaults. */
export interface SessionInsertMutation {
  kind: "session_insert";
  sessionId: string;
  slug: string;
  sessionName: string | null;
  taskDescription: string;
  status: "active" | "completed";
  mode: "interactive" | "loop";
  workspace: string | null;
  content: string | null;
  progressDone: number;
  progressTotal: number;
}

/** Set a session's status and progress; a null `content` keeps the old one. */
export interface SessionUpdateMutation {
  kind: "session_update";
  sessionId: string;
  status: "active" | "completed";
  progressDone: number;
  progressTotal: number;
  content: string | null;
}

/**
 * Insert a memory, or, when the slug exists, replace its name, description
 * and content (type, visibility, inject class and id are kept).
 */
export interface MemoryUpsertMutation {
  kind: "memory_upsert";
  memoryId: string;
  slug: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
}

export type UnjournaledMutation =
  | SessionInsertMutation
  | SessionUpdateMutation
  | MemoryUpsertMutation;

export function isDeclaredMutationKind(
  kind: unknown,
): kind is UnjournaledMutationKind {
  return typeof kind === "string" &&
    Object.hasOwn(UNJOURNALED_MUTATION_KINDS, kind);
}

/** Thrown by `commit` for a mutation whose kind is not declared above. */
export class UndeclaredMutationError extends Error {
  constructor(kind: unknown) {
    super(`undeclared unjournaled mutation kind: ${String(kind)}`);
    this.name = "UndeclaredMutationError";
  }
}

/** Reject the whole batch before anything is written. */
export function assertDeclaredMutations(
  mutations: readonly { kind: unknown }[],
): void {
  for (const mutation of mutations) {
    if (!isDeclaredMutationKind(mutation.kind)) {
      throw new UndeclaredMutationError(mutation.kind);
    }
  }
}
