// The Unix-socket skip decision, with the probe outcome injected: it skips on
// a refused bind (EPERM) outside CI, and nowhere else (BIT-806).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindOutcomeFromExit,
  inCi,
  probeUnixSocketBind,
  unixSocketSkipReason,
} from "./unix-socket-bind.ts";

const refused = { ok: false, code: "EPERM" } as const;

describe("the Unix-socket skip decision", () => {
  it("skips, naming the refusal, on EPERM outside CI", () => {
    const reason = unixSocketSkipReason(refused, {});
    assert.match(reason ?? "", /may not bind a Unix socket/);
    assert.match(reason ?? "", /EPERM/);
  });

  it("does not skip when the bind works", () => {
    assert.equal(unixSocketSkipReason({ ok: true }, {}), undefined);
  });

  it("does not skip on any other bind error, so the suite fails on it", () => {
    for (const code of ["EACCES", "ENOENT", "EADDRINUSE", "ENAMETOOLONG", undefined]) {
      assert.equal(unixSocketSkipReason({ ok: false, code }, {}), undefined, String(code));
    }
  });

  it("never skips under CI: a refusal there fails the suite", () => {
    for (const env of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
      assert.equal(unixSocketSkipReason(refused, env), undefined, JSON.stringify(env));
    }
  });

  it("reads CI only from a real value", () => {
    for (const env of [{}, { CI: "" }, { CI: "false" }, { CI: "0" }, { GITHUB_ACTIONS: "false" }]) {
      assert.equal(inCi(env), false, JSON.stringify(env));
    }
  });

  it("reads the probe child's exit as an outcome", () => {
    assert.deepEqual(bindOutcomeFromExit(0, ""), { ok: true });
    assert.deepEqual(bindOutcomeFromExit(10, ""), { ok: false, code: "EPERM" });
    assert.deepEqual(bindOutcomeFromExit(11, "EACCES\n"), { ok: false, code: "EACCES" });
    assert.deepEqual(bindOutcomeFromExit(11, ""), { ok: false, code: undefined });
    assert.deepEqual(bindOutcomeFromExit(null, ""), { ok: false, code: undefined });
    assert.deepEqual(bindOutcomeFromExit(1, ""), { ok: false, code: undefined });
  });

  it("does not take a failure to make the probe's directory for a refused bind", () => {
    // An EPERM from mkdtemp says nothing about binding a socket, so the suite
    // runs and fails on it; only the bind's own EPERM (exit 10) skips.
    const directory = bindOutcomeFromExit(12, "EPERM");
    assert.deepEqual(directory, { ok: false, code: "mkdtemp:EPERM" });
    assert.equal(unixSocketSkipReason(directory, {}), undefined);
    assert.equal(
      unixSocketSkipReason(bindOutcomeFromExit(12, ""), {}),
      undefined,
    );
    assert.match(
      unixSocketSkipReason(bindOutcomeFromExit(10, ""), {}) ?? "",
      /may not bind a Unix socket/,
    );
  });

  it("probes this machine and reports a code on refusal", () => {
    const outcome = probeUnixSocketBind();
    assert.ok(outcome.ok || typeof outcome.code === "string" || outcome.code === undefined);
  });

  it("reports a directory that cannot be made as a directory failure, which does not skip", () => {
    const outcome = probeUnixSocketBind("/nonexistent-dyfj-probe-dir");
    assert.deepEqual(outcome, { ok: false, code: "mkdtemp:ENOENT" });
    assert.equal(unixSocketSkipReason(outcome, {}), undefined);
  });

  it("leaves no live handle in the process that probes", () => {
    const before = process.getActiveResourcesInfo().slice().sort();
    probeUnixSocketBind();
    const after = process.getActiveResourcesInfo().slice().sort();
    assert.deepEqual(after, before);
  });
});
