import assert from "node:assert/strict";
import { test } from "node:test";
import { loopbackSkipReason, probeLoopbackBind } from "./loopback-bind.ts";

test("loopback skips only EPERM outside CI, with a reason", () => {
  assert.match(loopbackSkipReason({ ok: false, code: "EPERM" }, {}) ?? "", /loopback.*EPERM/);
  assert.equal(loopbackSkipReason({ ok: true }, {}), undefined);
  for (const code of ["EACCES", "EADDRINUSE", undefined]) {
    assert.equal(loopbackSkipReason({ ok: false, code }, {}), undefined);
  }
  for (const env of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
    assert.equal(loopbackSkipReason({ ok: false, code: "EPERM" }, env), undefined);
  }
  for (const env of [{ CI: "false" }, { CI: "0" }, { CI: "" }]) {
    assert.ok(loopbackSkipReason({ ok: false, code: "EPERM" }, env));
  }
});

test("loopback probe reports an outcome and leaves no parent handles", () => {
  const before = process.getActiveResourcesInfo().slice().sort();
  const outcome = probeLoopbackBind();
  assert.ok(outcome.ok || typeof outcome.code === "string" || outcome.code === undefined);
  assert.deepEqual(process.getActiveResourcesInfo().slice().sort(), before);
});
