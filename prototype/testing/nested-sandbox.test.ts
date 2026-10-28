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
    const reason = nestedSandboxSkipReason("darwin", refused);
    assert.match(reason ?? "", /already inside a sandbox/);
    assert.match(reason ?? "", /sandbox_apply: Operation not permitted/);
  });

  it("lets the test run when the probe sandbox starts", () => {
    assert.equal(
      nestedSandboxSkipReason("darwin", () => ({ status: 0, stderr: "" })),
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
      assert.equal(nestedSandboxSkipReason("darwin", () => outcome), undefined);
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

  it("answers for this machine without throwing", () => {
    const reason = nestedSandboxSkipReason();
    assert.ok(reason === undefined || typeof reason === "string");
  });
});
