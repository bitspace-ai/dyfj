// The nested-sandbox check's decision, with the probe injected: it skips only
// on macOS and only on the sandbox's own refusal (BIT-806).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nestedSandboxSkipReason } from "./nested-sandbox.ts";

const refused = () => ({
  status: 71,
  stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n",
});

describe("the nested-sandbox check", () => {
  it("names the reason when macOS refuses to nest a sandbox", () => {
    const reason = nestedSandboxSkipReason("darwin", refused, {});
    assert.match(reason ?? "", /already inside a sandbox/);
    assert.match(reason ?? "", /sandbox_apply: Operation not permitted/);
  });

  it("lets the test run when the probe sandbox starts", () => {
    assert.equal(
      nestedSandboxSkipReason("darwin", () => ({ status: 0, stderr: "" }), {}),
      undefined,
    );
  });

  it("lets the test run when the probe fails for another reason", () => {
    for (
      const outcome of [
        { status: 1, stderr: "sandbox-exec: invalid profile\n" },
        { status: null, stderr: "" },
        { status: 71, stderr: "" },
      ]
    ) {
      assert.equal(nestedSandboxSkipReason("darwin", () => outcome, {}), undefined);
    }
  });

  it("does not probe, and does not skip, off macOS", () => {
    for (const platform of ["linux", "win32"]) {
      assert.equal(
        nestedSandboxSkipReason(platform, () => {
          throw new Error("probed");
        }),
        undefined,
        platform,
      );
    }
  });

  it("never skips under CI: the test runs, and a refusal fails it", () => {
    for (const env of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
      let probed = false;
      const reason = nestedSandboxSkipReason("darwin", () => {
        probed = true;
        return refused();
      }, env);
      assert.equal(reason, undefined, JSON.stringify(env));
      assert.equal(probed, false, "no probe is needed under CI");
    }
  });

  it("still skips when CI is set to a false value", () => {
    for (const env of [{ CI: "" }, { CI: "false" }, { CI: "0" }, { GITHUB_ACTIONS: "false" }]) {
      assert.match(
        nestedSandboxSkipReason("darwin", refused, env) ?? "",
        /already inside a sandbox/,
        JSON.stringify(env),
      );
    }
  });

  it("answers for this machine without throwing", () => {
    const reason = nestedSandboxSkipReason();
    assert.ok(reason === undefined || typeof reason === "string");
  });
});
