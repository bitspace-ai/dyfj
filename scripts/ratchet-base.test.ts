// Tests for the `ratchet.base` lane: each committed ratchet list is compared
// with the same list at the merge base, so an entry cannot grow, or appear,
// without a `growth_reason` in the same change. Written to node: builtins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import {
  ARCH_BASELINE_PATH,
  archBaselineGrowth,
  resolveRatchetBase,
  runRatchetBase,
  RUNTIME_NEUTRAL_PATH,
  runtimeNeutralGrowth,
  SIZE_EXCEPTIONS_PATH,
  sizeExceptionGrowth,
} from "./ratchet-base.ts";

const neutral = (path: string, count: number, extra = {}) => ({
  path,
  count,
  reason: "ported under a later leaf",
  ...extra,
});

const moduleSize = (path: string, lines: number, extra = {}) => ({
  kind: "module",
  path,
  lines,
  reason: "deferred",
  ...extra,
});

const emptyArchBaseline = {
  cycles: [],
  layer: [],
  cli: [],
  dynamic: [],
  env: [],
  envKeys: [],
  packages: [],
  sqlWrites: [],
};

describe("runtimeNeutralGrowth", () => {
  it("passes when an entry shrinks or goes", () => {
    const result = runtimeNeutralGrowth(
      [neutral("a.ts", 5), neutral("b.ts", 2)],
      [neutral("a.ts", 3)],
    );
    assert.deepEqual(result, { errors: [], accepted: [] });
  });

  it("fails when an entry's count grows without a growth_reason", () => {
    const { errors } = runtimeNeutralGrowth(
      [neutral("a.ts", 3)],
      [neutral("a.ts", 4)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /a\.ts: count grew from 3 to 4/);
    assert.match(errors[0] ?? "", /growth_reason/);
  });

  it("fails when a new entry appears without a growth_reason", () => {
    const { errors } = runtimeNeutralGrowth([], [neutral("new.ts", 1)]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /new\.ts: new entry \(1\)/);
  });

  it("passes growth that carries a growth_reason, and reports it", () => {
    const result = runtimeNeutralGrowth(
      [neutral("a.ts", 3)],
      [
        neutral("a.ts", 4, { growth_reason: "moved a call into this file" }),
        neutral("new.ts", 2, { growth_reason: "split out of a.ts" }),
      ],
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.accepted, [
      "a.ts: count grew from 3 to 4: moved a call into this file",
      "new.ts: new entry (2): split out of a.ts",
    ]);
  });

  it("does not accept a growth_reason already present at the base", () => {
    const reason = { growth_reason: "an earlier change's reason" };
    const { errors } = runtimeNeutralGrowth(
      [neutral("a.ts", 3, reason)],
      [neutral("a.ts", 5, reason)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /a\.ts: count grew from 3 to 5/);
  });

  it("rejects a growth_reason that is not a non-empty string", () => {
    const { errors } = runtimeNeutralGrowth(
      [neutral("a.ts", 3)],
      [neutral("a.ts", 4, { growth_reason: "  " })],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /growth_reason must be a non-empty string/);
  });

  it("strips control bytes from a reported reason", () => {
    const { accepted } = runtimeNeutralGrowth(
      [],
      [neutral("a.ts", 1, { growth_reason: "ok\x1b[2J\nreason" })],
    );
    assert.deepEqual(accepted, ["a.ts: new entry (1): ok[2Jreason"]);
  });
});

describe("sizeExceptionGrowth", () => {
  it("passes when a recorded size shrinks or an exception goes", () => {
    const result = sizeExceptionGrowth(
      [moduleSize("m.ts", 1200), moduleSize("n.ts", 1100)],
      [moduleSize("m.ts", 1150)],
    );
    assert.deepEqual(result, { errors: [], accepted: [] });
  });

  it("fails when a recorded size grows without a growth_reason", () => {
    const { errors } = sizeExceptionGrowth(
      [moduleSize("m.ts", 1200)],
      [moduleSize("m.ts", 1250)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /module m\.ts: lines grew from 1200 to 1250/);
  });

  it("keys a function exception by file and name", () => {
    const fn = (name: string, lines: number, extra = {}) => ({
      kind: "function",
      path: "m.ts",
      name,
      lines,
      reason: "deferred",
      ...extra,
    });
    const { errors, accepted } = sizeExceptionGrowth(
      [fn("run", 220)],
      [fn("run", 220), fn("start", 210, { growth_reason: "new runner" })],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(accepted, [
      "function m.ts start: new entry (210): new runner",
    ]);
  });
});

describe("archBaselineGrowth", () => {
  it("passes when the baseline stays empty or shrinks", () => {
    assert.deepEqual(
      archBaselineGrowth(
        { ...emptyArchBaseline, layer: ["a -> b"] },
        emptyArchBaseline,
      ),
      [],
    );
  });

  it("fails on any new entry, with no override", () => {
    const errors = archBaselineGrowth(emptyArchBaseline, {
      ...emptyArchBaseline,
      layer: ["a -> b"],
      growth_reason: "not honoured here",
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /new layer entry/);
    assert.match(errors[0] ?? "", /fix the violation/);
  });
});

// A throwaway repository: `base` lists are committed on a base commit, a
// branch commit replaces them with `head` lists, and HEAD is left there.
function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "dyfj-test",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "dyfj-test",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed in fixture (exit ${result.status})`);
  }
  return result.stdout.trim();
}

function writeLists(dir: string, lists: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(lists)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  }
}

const baseLists = {
  [RUNTIME_NEUTRAL_PATH]: [neutral("a.ts", 3)],
  [SIZE_EXCEPTIONS_PATH]: [moduleSize("m.ts", 1200)],
  [ARCH_BASELINE_PATH]: emptyArchBaseline,
};

function withRepo(
  head: Record<string, unknown>,
  run: (dir: string, base: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dyfj-ratchet-base-"));
  return (async () => {
    try {
      git(dir, "init", "-q", "-b", "main");
      writeLists(dir, baseLists);
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "base");
      const base = git(dir, "rev-parse", "HEAD");
      git(dir, "checkout", "-q", "-b", "change");
      writeLists(dir, head);
      git(dir, "add", ".");
      git(dir, "commit", "-q", "--allow-empty", "-m", "change");
      await run(dir, base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function capture() {
  const lines: string[] = [];
  return {
    lines,
    out: {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    },
  };
}

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

describe("resolveRatchetBase", () => {
  it("takes the merge base of the bound range base and HEAD", async () => {
    await withRepo({}, async (dir, base) => {
      const resolution = await resolveRatchetBase(
        dir,
        envOf({ DYFJ_GATE_RANGE_BASE: base, GITHUB_ACTIONS: "true" }),
      );
      assert.deepEqual(resolution, {
        kind: "resolved",
        commit: base,
        source: "env",
      });
    });
  });

  it("falls back to origin/main locally", async () => {
    await withRepo({}, async (dir, base) => {
      git(dir, "update-ref", "refs/remotes/origin/main", base);
      const resolution = await resolveRatchetBase(dir, envOf({}));
      assert.deepEqual(resolution, {
        kind: "resolved",
        commit: base,
        source: "origin/main",
      });
    });
  });

  it("is unresolved without a bound base or origin/main", async () => {
    await withRepo({}, async (dir) => {
      const resolution = await resolveRatchetBase(dir, envOf({}));
      assert.equal(resolution.kind, "unresolved");
    });
  });
});

describe("runRatchetBase", () => {
  it("passes a change that only shrinks, and names the base it used", async () => {
    await withRepo(
      { [RUNTIME_NEUTRAL_PATH]: [neutral("a.ts", 2)] },
      async (dir, base) => {
        const { lines, out } = capture();
        const code = await runRatchetBase(
          dir,
          envOf({ DYFJ_GATE_RANGE_BASE: base, GITHUB_ACTIONS: "true" }),
          out,
        );
        assert.equal(code, 0, lines.join("\n"));
        assert.ok(
          lines.some((line) =>
            line.includes(base) && line.includes("DYFJ_GATE_RANGE_BASE")
          ),
          lines.join("\n"),
        );
      },
    );
  });

  it("fails growth without a reason in any list", async () => {
    await withRepo(
      {
        [RUNTIME_NEUTRAL_PATH]: [neutral("a.ts", 4)],
        [SIZE_EXCEPTIONS_PATH]: [moduleSize("m.ts", 1300)],
        [ARCH_BASELINE_PATH]: { ...emptyArchBaseline, cli: ["x -> y"] },
      },
      async (dir, base) => {
        const { lines, out } = capture();
        const code = await runRatchetBase(
          dir,
          envOf({ DYFJ_GATE_RANGE_BASE: base, GITHUB_ACTIONS: "true" }),
          out,
        );
        assert.equal(code, 1);
        const text = lines.join("\n");
        assert.match(text, /a\.ts: count grew from 3 to 4/);
        assert.match(text, /module m\.ts: lines grew from 1200 to 1300/);
        assert.match(text, /new cli entry/);
      },
    );
  });

  it("passes growth with a reason and reports the reason", async () => {
    await withRepo(
      {
        [RUNTIME_NEUTRAL_PATH]: [
          neutral("a.ts", 4, { growth_reason: "a reviewed move" }),
        ],
      },
      async (dir, base) => {
        const { lines, out } = capture();
        const code = await runRatchetBase(
          dir,
          envOf({ DYFJ_GATE_RANGE_BASE: base, GITHUB_ACTIONS: "true" }),
          out,
        );
        assert.equal(code, 0, lines.join("\n"));
        assert.ok(
          lines.some((line) =>
            line.includes("a.ts: count grew from 3 to 4: a reviewed move")
          ),
          lines.join("\n"),
        );
      },
    );
  });

  it("reports the origin/main fallback by name", async () => {
    await withRepo({}, async (dir, base) => {
      git(dir, "update-ref", "refs/remotes/origin/main", base);
      const { lines, out } = capture();
      assert.equal(await runRatchetBase(dir, envOf({}), out), 0);
      assert.ok(
        lines.some((line) =>
          line.includes(base) && line.includes("origin/main")
        ),
        lines.join("\n"),
      );
    });
  });

  it("skips locally, and says so, when no base resolves", async () => {
    await withRepo(
      { [RUNTIME_NEUTRAL_PATH]: [neutral("a.ts", 9)] },
      async (dir) => {
        const { lines, out } = capture();
        assert.equal(await runRatchetBase(dir, envOf({}), out), 0);
        assert.match(lines.join("\n"), /skipped/);
      },
    );
  });

  it("fails closed in CI without a bound range base", async () => {
    await withRepo({}, async (dir) => {
      const { lines, out } = capture();
      const code = await runRatchetBase(
        dir,
        envOf({ GITHUB_ACTIONS: "true" }),
        out,
      );
      assert.equal(code, 1);
      assert.match(lines.join("\n"), /failing closed/);
    });
  });

  it("fails closed in CI when the bound base shares no history with HEAD", async () => {
    await withRepo({}, async (dir) => {
      // An unrelated root commit stands in for a base a shallow clone lacks
      // the history to join: `git merge-base` finds nothing.
      git(dir, "checkout", "-q", "--orphan", "unrelated");
      git(dir, "commit", "-q", "--allow-empty", "-m", "unrelated");
      const unrelated = git(dir, "rev-parse", "HEAD");
      git(dir, "checkout", "-q", "change");
      const { lines, out } = capture();
      const code = await runRatchetBase(
        dir,
        envOf({ DYFJ_GATE_RANGE_BASE: unrelated, GITHUB_ACTIONS: "true" }),
        out,
      );
      assert.equal(code, 1);
      assert.match(lines.join("\n"), /failing closed/);
    });
  });
});
