/**
 * The model's copy of its own redacted tool results across turns (BIT-812).
 *
 * A `redactResult` command (bash, git, linear, MCP, web) persists only the
 * sentinel in its durable `tool_call` event, and every turn rebuilds the
 * model's history from that log. Without this store a later turn replays
 * each such result as a bare `[redacted]`, and the model fills the gap with
 * results it never saw.
 *
 * Declared exception to AGENTS.md rule 4 (the log is the write path): this
 * is model working context, not a projection, and it cannot be rebuilt by
 * replay, because the log never holds what it keeps. It holds only result
 * text a turn added to the model's transcript, and it is never written
 * anywhere: not to the store, events, receipts, logs or frames. Durable
 * redaction policy is unchanged.
 *
 * One store per engine, owned by `SessionOwners` like the session grants,
 * and kept in memory for the engine's lifetime: a restart loses it. It is
 * bounded: at most `MAX_TRACKED_SESSIONS` sessions, each holding at most
 * `MAX_ENTRIES_PER_SESSION` results and `MAX_CHARS_PER_SESSION` characters
 * of keys, clearance scopes and result text, with the oldest session or
 * result dropped first. A result is keyed by the trace id of the turn that ran it and its
 * call id, and is returned only to a caller in the clearance scope that
 * recorded it. A miss gets `withheldToolResult`.
 */

import type { WorkbenchAuthContext } from "../contract/mod.ts";

/** Sessions tracked at once; the least recently created is dropped first. */
export const MAX_TRACKED_SESSIONS = 64;
/** Results one session may hold; the oldest is dropped first. */
export const MAX_ENTRIES_PER_SESSION = 1024;
/** Characters of key, scope and result one session may hold; oldest first. */
export const MAX_CHARS_PER_SESSION = 2_000_000;

/** One session's recorded results, read and written in one clearance scope. */
export interface SessionToolHistory {
  record(traceId: string, callId: string, text: string): void;
  lookup(traceId: string, callId: string): string | undefined;
}

/** Where a turn finds its session's tool history. */
export interface ToolHistoryScopes {
  toolHistory(
    sessionId: string,
    authContext: WorkbenchAuthContext | undefined,
  ): SessionToolHistory;
}

interface Entry {
  scope: string;
  text: string;
  chars: number;
}

interface SessionEntries {
  entries: Map<string, Entry>;
  chars: number;
}

export class ToolHistoryStore implements ToolHistoryScopes {
  readonly #sessions = new Map<string, SessionEntries>();

  toolHistory(
    sessionId: string,
    authContext: WorkbenchAuthContext | undefined,
  ): SessionToolHistory {
    const scope = clearanceScope(authContext);
    return {
      record: (traceId, callId, text) =>
        this.#record(sessionId, scope, entryKey(traceId, callId), text),
      lookup: (traceId, callId) => {
        const entry = this.#sessions.get(sessionId)?.entries.get(
          entryKey(traceId, callId),
        );
        return entry?.scope === scope ? entry.text : undefined;
      },
    };
  }

  #record(sessionId: string, scope: string, key: string, text: string) {
    const chars = key.length + scope.length + text.length;
    if (chars > MAX_CHARS_PER_SESSION) return;
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      if (this.#sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.#sessions.keys().next().value;
        if (oldest !== undefined) this.#sessions.delete(oldest);
      }
      session = { entries: new Map(), chars: 0 };
      this.#sessions.set(sessionId, session);
    }
    const prior = session.entries.get(key);
    if (prior !== undefined) {
      session.entries.delete(key);
      session.chars -= prior.chars;
    }
    session.entries.set(key, { scope, text, chars });
    session.chars += chars;
    for (const [oldest, entry] of session.entries) {
      if (
        session.chars <= MAX_CHARS_PER_SESSION &&
        session.entries.size <= MAX_ENTRIES_PER_SESSION
      ) {
        break;
      }
      session.entries.delete(oldest);
      session.chars -= entry.chars;
    }
  }
}

function entryKey(traceId: string, callId: string): string {
  return `${traceId}\u0000${callId}`;
}

/**
 * The scope a result is readable in: who called and over what transport. A
 * turn on the same session id with any other clearance reads nothing.
 */
function clearanceScope(authContext: WorkbenchAuthContext | undefined): string {
  if (authContext === undefined) return "none";
  return JSON.stringify([
    authContext.transport,
    authContext.authnStatus,
    authContext.authnMechanism,
    authContext.authnIssuerRef,
    authContext.authzBasis,
  ]);
}

/**
 * What the model gets in place of a redacted result it can no longer be
 * shown. It says the output is unavailable and how to see it, so it cannot
 * be read as the command's output. It carries no length or content-derived
 * value, like the sentinel it replaces.
 */
export function withheldToolResult(commandId: string): string {
  return `[tool output not available: the output of this ${commandId} call ` +
    "is not kept in session history (class: unpersisted command output). " +
    "This text is not the command's output. Rerun the command to see it.]";
}
