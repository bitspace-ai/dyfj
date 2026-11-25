import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  loadWorkspacesConfig,
  parseWorkspacesConfig,
} from "./workspaces-config.ts";
import { WorkspaceProfiles } from "./workspace-policy.ts";

const WHERE = "/fixture/config.toml";
const HOME = "/fixture/operator";
const env = new MapEnv({ HOME });
const none = (root: string) => ({ path: root }) as Record<string, unknown>;

function parse(profiles: unknown[]): ReturnType<typeof parseWorkspacesConfig> {
  return parseWorkspacesConfig({ workspaces: profiles }, WHERE, env);
}

describe("workspaces config: an absent table", () => {
  it("leaves the flat global sections as the only configuration", () => {
    for (const table of [null, {}, { gate: {} }]) {
      const parsed = parseWorkspacesConfig(table, WHERE, env);
      assert.deepStrictEqual(parsed.profiles, []);
      assert.strictEqual(parsed.match(resolve(HOME, "anything")), null);
    }
  });

  it("loadWorkspacesConfig is empty when the config file does not exist", async () => {
    const loaded = await loadWorkspacesConfig({
      env,
      readTextFile: () =>
        Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
      parseToml: () => ({}),
    });
    assert.deepStrictEqual(loaded.profiles, []);
  });
});

describe("workspaces config: one profile", () => {
  it("parses path, trust_instructions and every scoped section", () => {
    const parsed = parse([{
      path: "~/projects/dyfj",
      trust_instructions: true,
      gate: { command: ["npm", "test"], fast_command: ["npm", "run", "test:fast"] },
      publish: {
        pre_gate: ["./scripts/pre-gate"],
        gate: ["./scripts/gate", "--range={range}"],
        push: ["git", "push", "origin", "{head}:refs/heads/{branch}"],
        open_pr: ["gh", "pr", "create"],
        base_ref: "origin/master",
      },
      sandbox: {
        allow_domains: ["static.crates.io"],
        deny_read: [".example/token"],
        require_worktree: true,
      },
      dispatch: { roots: ["~/projects/dyfj-worktrees"] },
    }]);
    assert.strictEqual(parsed.profiles.length, 1);
    const profile = parsed.profiles[0]!;
    assert.strictEqual(profile.path, resolve(HOME, "projects/dyfj"));
    assert.strictEqual(profile.trustInstructions, true);
    assert.deepStrictEqual(profile.gate?.commands.full, ["npm", "test"]);
    assert.deepStrictEqual(profile.gate?.commands.fast, ["npm", "run", "test:fast"]);
    assert.strictEqual(profile.gate?.commands.files, undefined);
    assert.deepStrictEqual(profile.publish?.preGate, ["./scripts/pre-gate"]);
    assert.strictEqual(profile.publish?.baseRef, "origin/master");
    assert.deepStrictEqual(profile.sandbox?.allowDomains, ["static.crates.io"]);
    assert.deepStrictEqual(profile.sandbox?.denyRead, [".example/token"]);
    assert.strictEqual(profile.sandbox?.requireWorktree, true);
    assert.deepStrictEqual(profile.dispatch?.roots, [
      resolve(HOME, "projects/dyfj-worktrees"),
    ]);
  });

  it("leaves an unset section unset, so the global section still applies", () => {
    const profile = parse([none("/work/example")]).profiles[0]!;
    assert.strictEqual(profile.trustInstructions, null);
    assert.strictEqual(profile.gate, null);
    assert.strictEqual(profile.publish, null);
    assert.strictEqual(profile.sandbox, null);
    assert.strictEqual(profile.dispatch, null);
  });

  it("defaults require_worktree to false", () => {
    const profile = parse([{
      path: "/work/example",
      sandbox: { allow_domains: ["example.com"] },
    }]).profiles[0]!;
    assert.strictEqual(profile.sandbox?.requireWorktree, false);
  });

  it("validates each scoped section with its global counterpart's rules", () => {
    assert.throws(
      () => parse([{ path: "/w", sandbox: { allow_domains: ["*"] } }]),
      /allow_domains entry 1/,
    );
    assert.throws(
      () => parse([{ path: "/w", publish: { pre_gate: ["sh"], gate: ["./gate"] } }]),
      /runs a shell or a text-evaluating runtime/,
    );
    assert.throws(
      () => parse([{ path: "/w", gate: { command: [] } }]),
      /gate\.command must be a non-empty argv array/,
    );
    assert.throws(
      () => parse([{ path: "/w", dispatch: {} }]),
      /dispatch\.roots is required/,
    );
  });
});

describe("workspaces config: path matching", () => {
  it("matches the root itself and any path under it, and nothing else", () => {
    const parsed = parse([none("/projects/dyfj")]);
    assert.notStrictEqual(parsed.match("/projects/dyfj"), null);
    assert.notStrictEqual(parsed.match("/projects/dyfj/prototype"), null);
    assert.strictEqual(parsed.match("/projects/dyfj-other"), null);
    assert.strictEqual(parsed.match("/projects"), null);
  });

  it("picks the most specific canonical match", () => {
    const parsed = parse([none("/projects"), none("/projects/dyfj")]);
    assert.strictEqual(
      parsed.match("/projects/dyfj/prototype")?.path,
      "/projects/dyfj",
    );
    assert.strictEqual(parsed.match("/projects/other")?.path, "/projects");
  });

  it("expands ~ and requires an absolute path", () => {
    assert.strictEqual(parse([none("~/w")]).profiles[0]!.path, resolve(HOME, "w"));
    assert.throws(() => parse([none("relative/w")]), /must be an absolute path/);
    assert.throws(() => parse([none("/w/../x")]), /must not contain a "\.\."/);
  });

  it("refuses the same canonical root twice: no profile may shadow another", () => {
    assert.throws(
      () => parse([none("~/projects/dyfj"), none("/fixture/operator/projects/dyfj/")]),
      /duplicate workspaces path/,
    );
  });

  it("refuses an entry with no path, a non-array, and an unknown key", () => {
    assert.throws(() => parse([{ trust_instructions: true }]), /path is required/);
    assert.throws(() => parseWorkspacesConfig({ workspaces: {} }, WHERE, env), /must be an array/);
    assert.throws(
      () => parse([{ path: "/w", commands: {} }]),
      /unknown key workspaces\.commands/,
    );
    assert.throws(
      () => parse([{ path: "/w", trust_instructions: "yes" }]),
      /trust_instructions must be a boolean/,
    );
  });
});

describe("workspace profiles: resolution against the globals", () => {
  const env = new MapEnv({ HOME: HOME });
  const globals = {
    trustInstructions: false,
    gate: { commands: { full: ["npm", "test"] }, timeoutSeconds: 60 },
    publish: null,
    sandbox: { allowDomains: [], denyRead: [] },
    dispatch: null,
  };

  function profiles(table: Record<string, unknown>) {
    return new WorkspaceProfiles(parseWorkspacesConfig(table, WHERE, env), globals);
  }

  it("a profile's section replaces the global one whole", () => {
    const config = profiles({
      workspaces: [{
        path: "/repo",
        trust_instructions: true,
        gate: { command: ["make", "check"] },
      }],
    });
    const resolved = config.resolve("/repo");
    assert.equal(resolved.trustInstructions, true);
    assert.deepStrictEqual(resolved.gate?.commands, { full: ["make", "check"] });
    // A section the profile omits keeps the global one.
    assert.deepStrictEqual(resolved.sandbox, globals.sandbox);
    // An unmatched workspace keeps every global section.
    const other = config.resolve("/elsewhere");
    assert.equal(other.trustInstructions, false);
    assert.deepStrictEqual(other.gate, globals.gate);
    assert.equal(other.profile, null);
  });

  it("a profile's sandbox additions stay additive", async () => {
    const config = profiles({
      workspaces: [{
        path: "/repo",
        sandbox: { allow_domains: ["static.crates.io"], deny_read: [".token"], require_worktree: true },
      }],
    });
    assert.deepStrictEqual(await config.allowDomainsFor("/repo"), ["static.crates.io"]);
    assert.deepStrictEqual(await config.denyReadFor("/repo"), [".token"]);
    assert.equal(await config.requireWorktreeFor("/repo"), true);
    // Unmatched workspaces add nothing at all.
    assert.deepStrictEqual(await config.allowDomainsFor("/elsewhere"), []);
    assert.deepStrictEqual(await config.denyReadFor("/elsewhere"), []);
    assert.equal(await config.requireWorktreeFor("/elsewhere"), false);
  });

  it("a workspace under a profiled root matches, a sibling with a shared prefix does not", () => {
    const config = profiles({ workspaces: [{ path: "/repo" }] });
    assert.notEqual(config.match("/repo/worktree"), null);
    assert.equal(config.match("/repo-other"), null);
  });

  it("no profiles leaves every global section in force", () => {
    const config = profiles({});
    const resolved = config.resolve("/anywhere");
    assert.deepStrictEqual(resolved.gate, globals.gate);
    assert.equal(resolved.profile, null);
  });
});

describe("workspace profiles: a path that does not exist yet", () => {
  it("matches once created beneath a symlinked parent", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "dyfj-profiles-")));
    try {
      // `/alias` is a symlink to `/real`, and the profile names a directory
      // under the alias that does not exist at boot.
      const real = join(base, "real");
      mkdirSync(real);
      symlinkSync(real, join(base, "alias"));
      const configured = join(base, "alias", "new-repo");
      const config = parseWorkspacesConfig(
        { workspaces: [{ path: configured, trust_instructions: true }] },
        WHERE,
        env,
      );
      // The directory appears after boot, reached through the real path.
      const created = join(real, "new-repo");
      mkdirSync(created);
      const matched = config.match(created);
      assert.notEqual(
        matched,
        null,
        "a profile under a symlinked parent must match once its directory exists",
      );
      assert.equal(matched?.path, created);
      // And a workspace beneath it matches too.
      mkdirSync(join(created, "worktree"));
      assert.equal(config.match(join(created, "worktree"))?.path, created);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("workspace profiles: the filesystem root as a profile", () => {
  it("covers a workspace no deeper profile names", () => {
    const parsed = parse([{ path: "/", trust_instructions: true }]);
    assert.strictEqual(parsed.profiles.length, 1);
    assert.strictEqual(parsed.profiles[0]!.path, "/");
    // Every ordinary canonical root is under the filesystem root.
    for (const root of ["/work/repo", "/work/repo/prototype", "/tmp"]) {
      assert.strictEqual(
        parsed.match(root)?.path,
        "/",
        `${root} must match the root profile`,
      );
    }
  });

  it("loses to every deeper profile, at any depth", () => {
    const parsed = parse([
      { path: "/", trust_instructions: true },
      { path: "/work", trust_instructions: false },
      { path: "/work/repo", gate: { command: ["npm", "test"] } },
    ]);
    assert.strictEqual(parsed.match("/work/repo")?.path, "/work/repo");
    assert.strictEqual(parsed.match("/work/repo/prototype")?.path, "/work/repo");
    assert.strictEqual(parsed.match("/work/other")?.path, "/work");
    assert.strictEqual(parsed.match("/elsewhere")?.path, "/");
  });

  it("does not treat a sibling sharing the root's name as covered by another", () => {
    const parsed = parse([{ path: "/work/repo", trust_instructions: true }]);
    assert.strictEqual(parsed.match("/work/repoother"), null);
  });
});
