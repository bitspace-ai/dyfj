import assert from "node:assert/strict";
import { it } from "node:test";
import { CommandExecutionError } from "./definition.ts";

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order the constructor gives them is pinned.
it("CommandExecutionError keeps its own properties and message", () => {
  const err = new CommandExecutionError("why");
  assert.deepStrictEqual(Object.keys(err), ["publicReason", "name"]);
  assert.strictEqual(err.publicReason, "why");
  assert.strictEqual(err.message, "why");
  assert.strictEqual(err.cause, undefined);
});
