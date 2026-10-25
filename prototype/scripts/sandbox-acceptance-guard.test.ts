// The isolated machine's acceptance run empties its run's workspace, so it
// must refuse every run that is not disposable before touching anything
// (BIT-779). These tests run its refusal alone (`--check-run`) against
// profiles written here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ACCEPTANCE = fileURLToPath(new URL("../sandbox/linux/acceptance.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "acceptance-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function check(profile: unknown): { status: number | null; out: string; err: string } {
  const path = join(dir, `profile-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, typeof profile === "string" ? profile : JSON.stringify(profile));
  const result = spawnSync("bash", [ACCEPTANCE, "--check-run", path], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const profile = (run: string, workspace = `/srv/dyfj/work/${run}`) => ({
  identity: { run },
  workspace,
});

describe("the acceptance run's refusal", () => {
  for (const run of ["uat-bit779-20261025-a1b2c3", "acc-1"]) {
    it(`accepts the disposable run ${run}`, () => {
      const { status, out } = check(profile(run));
      assert.strictEqual(status, 0);
      assert.strictEqual(out, `disposable: /srv/dyfj/work/${run}\n`);
    });
  }

  for (const run of ["run-0001", "wk-20261025-093808-8e4e35", "uat", "UAT-x", "uat-", "spike-1", ""]) {
    it(`refuses the run ${JSON.stringify(run)}`, () => {
      const { status, err } = check(profile(run));
      assert.strictEqual(status, 2);
      assert.match(err, /is not disposable/);
    });
  }

  it("refuses a disposable run ID whose workspace is another run's", () => {
    const { status, err } = check(profile("uat-x", "/srv/dyfj/work/run-0001"));
    assert.strictEqual(status, 2);
    assert.match(err, /is not run uat-x's own/);
  });

  it("refuses a profile it cannot read", () => {
    assert.strictEqual(check("{not json").status, 2);
    assert.strictEqual(check({ workspace: "/srv/dyfj/work/uat-x" }).status, 2);
  });
});
