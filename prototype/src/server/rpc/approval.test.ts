import { assertEquals } from "@std/assert";
import { toApprovalVerdict } from "./approval.ts";

Deno.test("toApprovalVerdict approves only an explicit approve", () => {
  assertEquals(toApprovalVerdict({ decision: "approve" }), {
    decision: "approve",
  });
  assertEquals(toApprovalVerdict({ decision: "deny", reason: "no" }), {
    decision: "deny",
    reason: "no",
  });
  for (const response of [undefined, null, "approve", { decision: "yes" }]) {
    assertEquals(toApprovalVerdict(response), {
      decision: "deny",
      reason: "operator denied the tool call",
    });
  }
});
