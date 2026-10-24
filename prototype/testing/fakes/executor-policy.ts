/**
 * An executor-shaped effective policy for tests (BIT-736): the golden policy
 * fixture with no network, no database and no secrets, signed again after
 * `edit`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { policyDigest } from "../../src/config/effective-policy-digest.ts";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/effective-policy/policy.json", import.meta.url),
);

/** Signs `draft` in place and returns it. */
export function resign(draft: any): any {
  draft.identity.digest = "";
  draft.identity.digest = policyDigest(draft);
  return draft;
}

export function executorPolicy(edit: (draft: any) => void = () => {}): any {
  const draft = JSON.parse(readFileSync(FIXTURE, "utf8"));
  draft.network = { entries: [], brokerOperations: [], dolt: null };
  draft.secrets = [];
  draft.effects.limits.timeMs = null;
  edit(draft);
  return resign(draft);
}

/** Before the fixture's `expiresAt`. */
export const BEFORE_EXPIRY = new Date("2026-10-24T12:00:00.000Z");
