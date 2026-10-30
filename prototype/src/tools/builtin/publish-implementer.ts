/**
 * Which models implemented this session, as the publish gate's `{implementer}`.
 *
 * The value is the sorted, distinct list of model slugs that ran a turn in this
 * session, comma-joined, when that list is at most 256 characters. It comes from the runtime's own event log and never
 * from the worktree: a file in the worktree could claim anything.
 *
 * It is deliberately a list of slugs, not a family: `dyfj` does not decide
 * which family a model belongs to, and the operator's gate is where that
 * judgment belongs (it is the side with the reviewer to choose). That keeps
 * this module free of a catalog lookup, and free of the inactive-row question.
 *
 * A session that ran no model yields undefined, so a caller can refuse rather
 * than hand the gate an empty value.
 */

import type { EventReader } from "../../store/mod.ts";

/** The first read's size. A short answer means the whole log was read. */
export const EVENT_PAGE_SIZE = 1_000;

/**
 * The most events one scan will ask for. The reader caps a query at `limit` and
 * offers no offset, so a full scan is a doubling read: ask for N, and if N came
 * back full ask for 2N, until an answer is short. A session past this bound is
 * refused rather than reported from part of its log.
 */
export const MAX_SCANNED_EVENTS = 200_000;

/** The longest list the substitution will carry. */
const MAX_IMPLEMENTER_LENGTH = 256;

/**
 * The model slug one event names, when the event says a model actually ran a
 * turn. A failed, dispatched or cancelled call says nothing about who
 * implemented, and a compression call is the runtime's own bookkeeping.
 */
function ranModel(row: Readonly<Record<string, string>>): string | null {
  const type = row["event_type"];
  if (type !== "model_response" && type !== "provider_call") return null;
  const stop = row["stop_reason"];
  if (stop !== "stop" && stop !== "length" && stop !== "tool_use") return null;
  if (row["provider_call_purpose"] === "context_compression") return null;
  const slug = row["model_id"];
  return slug === undefined || slug === "" ? null : slug;
}

/**
 * The model slugs that ran turns in this session, sorted and comma-joined.
 * Undefined when none did or the joined list is longer than 256 characters;
 * throws when the log is longer than one scan will read. Reads the session's
 * events only.
 */
export async function resolveImplementer(input: {
  sessionId: string;
  events: EventReader;
}): Promise<string | undefined> {
  const slugs = new Set<string>();
  let limit = EVENT_PAGE_SIZE;
  for (;;) {
    const rows = await input.events.bySession({
      sessionId: input.sessionId,
      limit,
      order: "asc",
    });
    if (rows.length < limit) {
      for (const row of rows) {
        const slug = ranModel(row);
        if (slug !== null) slugs.add(slug);
      }
      break;
    }
    if (limit >= MAX_SCANNED_EVENTS) {
      throw new Error(
        `the session has at least ${limit} events; the implementer scan stops ` +
          `at ${MAX_SCANNED_EVENTS} and will not report part of the log`,
      );
    }
    limit = Math.min(limit * 2, MAX_SCANNED_EVENTS);
  }
  if (slugs.size === 0) return undefined;
  const joined = [...slugs].sort().join(",");
  return joined.length <= MAX_IMPLEMENTER_LENGTH ? joined : undefined;
}
