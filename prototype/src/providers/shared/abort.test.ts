import assert from "node:assert/strict";
import { it } from "@std/testing/bdd";
import { ProviderRequestAbortedError } from "./abort.ts";

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order the constructor gives them is pinned.
it("ProviderRequestAbortedError keeps its own properties and cause", () => {
  const cause = new Error("caller aborted");
  const err = new ProviderRequestAbortedError(5, { cause });
  assert.deepStrictEqual(Object.keys(err), ["elapsedMs", "name"]);
  assert.strictEqual(err.elapsedMs, 5);
  assert.strictEqual(err.message, "provider request aborted");
  assert.strictEqual(err.cause, cause);
});
