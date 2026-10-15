import assert from "node:assert/strict";
import { test } from "node:test";
import { toApprovalVerdict } from "./approval.ts";

test("toApprovalVerdict approves only an explicit approve", () => {
  assert.deepStrictEqual(toApprovalVerdict({ decision: "approve" }), {
    decision: "approve",
  });
  assert.deepStrictEqual(
    toApprovalVerdict({ decision: "deny", reason: "no" }),
    {
      decision: "deny",
      reason: "no",
    },
  );
  for (const response of [undefined, null, "approve", { decision: "yes" }]) {
    assert.deepStrictEqual(toApprovalVerdict(response), {
      decision: "deny",
      reason: "operator denied the tool call",
    });
  }
});
