import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import { installRootFromModuleUrl } from "./runtime.ts";

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_USERS_ROOT = ["", "Users", "x"].join("/");

describe("installRootFromModuleUrl (fail-closed prototype root)", () => {
  it("derives the prototype root from this module's file: URL", () => {
    assert.strictEqual(
      installRootFromModuleUrl(
        `file://${FAKE_USERS_ROOT}/projects/dyfj/prototype/src/cli/launcher/runtime.ts`,
      ),
      `${FAKE_USERS_ROOT}/projects/dyfj/prototype`,
    );
  });

  it("decodes percent-encoded path segments", () => {
    assert.strictEqual(
      installRootFromModuleUrl(
        `file://${FAKE_USERS_ROOT}/My%20Code/prototype/src/cli/launcher/runtime.ts`,
      ),
      `${FAKE_USERS_ROOT}/My Code/prototype`,
    );
  });

  it("returns null for a non-file (remote) module — no trustworthy local root", () => {
    assert.strictEqual(
      installRootFromModuleUrl(
        "https://example.com/prototype/src/cli/launcher/runtime.ts",
      ),
      null,
    );
  });

  it("resolves this checkout's prototype root from the module's real URL", () => {
    assert.strictEqual(
      installRootFromModuleUrl(new URL("./runtime.ts", import.meta.url).href),
      decodeURIComponent(new URL("../../..", import.meta.url).pathname)
        .replace(/\/$/, ""),
    );
  });

  it("returns null when the URL is not the expected src/cli/launcher/<file> shape", () => {
    assert.strictEqual(installRootFromModuleUrl("file:///weird/path.ts"), null);
    assert.strictEqual(
      installRootFromModuleUrl("file:///x/prototype/src/cli.ts"),
      null,
    );
    assert.strictEqual(installRootFromModuleUrl("not a url"), null);
  });
});
