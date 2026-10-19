/**
 * The "allow this exact call for the rest of the session" grants (BIT-707).
 * One store per engine, owned by `SessionOwners` like the ceiling
 * confirmations: keyed by session id, held in memory only and bounded, never
 * persisted. A new session or a runtime restart starts with none.
 */

import type { SessionGrants } from "../tools/mod.ts";

/** Sessions tracked at once; the least recently created is dropped first. */
const MAX_TRACKED_SESSIONS = 256;
/** Grants one session may hold; the oldest is dropped first. */
export const MAX_GRANTS_PER_SESSION = 256;

export class SessionGrantStore {
  readonly #sessions = new Map<string, Set<string>>();

  for(sessionId: string): SessionGrants {
    let keys = this.#sessions.get(sessionId);
    if (keys === undefined) {
      if (this.#sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.#sessions.keys().next().value;
        if (oldest !== undefined) this.#sessions.delete(oldest);
      }
      keys = new Set();
      this.#sessions.set(sessionId, keys);
    }
    const grants = keys;
    return {
      has: (key) => grants.has(key),
      add: (key) => {
        if (grants.has(key)) return;
        if (grants.size >= MAX_GRANTS_PER_SESSION) {
          const oldest = grants.values().next().value;
          if (oldest !== undefined) grants.delete(oldest);
        }
        grants.add(key);
      },
    };
  }
}
