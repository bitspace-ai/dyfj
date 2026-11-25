/**
 * Boot-to-catalog tests for workspace profiles (BIT-982).
 *
 * Two seams are pinned here:
 *
 * - A runtime whose operator config declares `gate`, `publish` and `dispatch`
 *   ONLY inside `[[workspaces]]` profiles still owns those tools' registries,
 *   and exposes each tool only to a turn whose resolved workspace has the
 *   section. Without this, the ordinary configuration - every command scoped to
 *   a repository - produced no tools at all.
 * - Every program a profile declares reaches the composed runtime policy's run
 *   list, tagged `workspace-config`, so `DYFJ_ROOT/config.toml` grants them at
 *   boot rather than refusing them mid-turn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  composeRuntimeGrants,
  parseWorkspacesConfig,
  type WorkspacesConfig,
  workspaceProfilePrograms,
} from "../config/mod.ts";
import { buildToolCatalog, RootAnchors } from "../tools/mod.ts";
import { bootToolSections, type ToolSections } from "./boot-tools.ts";

const HOME = "/home/example";
const GATE_ROOT = "/work/gated";
const PUBLISH_ROOT = "/work/published";
const DISPATCH_ROOT = "/work/coordinated";
const PLAIN_ROOT = "/work/plain";
const FREE_POLICY = { net: [], run: [], env: [], dolt: null } as const;

const env = new MapEnv({ HOME });

/** Parse `[[workspaces]]` profiles straight from the operator's table. */
function profiles(table: Record<string, unknown>): WorkspacesConfig {
  return parseWorkspacesConfig(table, "/home/example/.dyfj/config.toml", env);
}

/** Boot over an operator table with no global tool sections at all. */
async function boot(table: Record<string, unknown>): Promise<ToolSections> {
  return await bootToolSections({
    workspaces: profiles(table),
    trustInstructions: false,
    policy: FREE_POLICY,
    listenProbe: () =>
      Promise.resolve({ port: 0, accepted: () => false, close: () => {} }),
    env: new MapEnv({ HOME, DYFJ_SANDBOX: "off" }),
    deps: {
      env,
      readTextFile: () => Promise.resolve(""),
      parseToml: () => ({}),
    },
    say: () => {},
  });
}

/**
 * The tool ids a turn in `root` gets, built from the runtime's own ports and
 * the section the resolver gives that workspace - the same decision
 * `engine/build-context.ts` makes per turn.
 */
function toolIds(sections: ToolSections, root: string): string[] {
  const resolved = sections.workspaceConfig.resolve(root);
  return buildToolCatalog(
    {
      rootAnchors: new RootAnchors(),
      ...(sections.gate === undefined
        ? {}
        : {
          gate: {
            ...sections.gate,
            config: resolved.gate,
            sessionId: "session-1",
          },
        }),
      ...(sections.publish === undefined
        ? {}
        : {
          publish: {
            ...sections.publish,
            config: resolved.publish,
            policy: FREE_POLICY,
            sessionId: "session-1",
            resolveImplementer: () => Promise.resolve(""),
          },
        }),
    },
    { workspaceRoot: root },
    [],
    [],
  ).list().map((command) => command.id);
}

describe("workspace profiles: a runtime with no global tool sections", () => {
  it("owns gate ports when only a profile declares a gate, and exposes them there alone", async () => {
    const sections = await boot({
      workspaces: [{ path: GATE_ROOT, gate: { command: ["npm", "test"] } }],
    });
    assert.notStrictEqual(
      sections.gate,
      undefined,
      "the runtime owns gate ports so a profile can supply a section",
    );
    // No global [gate]: the ports carry no config of their own.
    assert.strictEqual(sections.gate?.config, null);
    assert.deepStrictEqual(
      sections.workspaceConfig.resolve(GATE_ROOT).gate?.commands.full,
      ["npm", "test"],
    );
    const gated = toolIds(sections, GATE_ROOT).filter((id) =>
      id.startsWith("gate/")
    );
    assert.deepStrictEqual(gated, ["gate/start", "gate/wait", "gate/cancel"]);
    assert.deepStrictEqual(
      toolIds(sections, PLAIN_ROOT).filter((id) => id.startsWith("gate/")),
      [],
      "an unmatched workspace gets no gate tools",
    );
  });

  it("owns a publish registry when only a profile declares publish, and exposes it there alone", async () => {
    const sections = await boot({
      workspaces: [{
        path: PUBLISH_ROOT,
        publish: {
          pre_gate: ["./scripts/pre-gate"],
          gate: ["./scripts/gate", "--range={range}"],
        },
      }],
    });
    assert.notStrictEqual(sections.publish, undefined);
    assert.strictEqual(sections.publish?.config, null);
    assert.notStrictEqual(
      sections.workspaceConfig.resolve(PUBLISH_ROOT).publish,
      null,
    );
    const published = toolIds(sections, PUBLISH_ROOT).filter((id) =>
      id.startsWith("publish/")
    );
    assert.deepStrictEqual(published, [
      "publish/start",
      "publish/status",
      "publish/cancel",
    ]);
    assert.deepStrictEqual(
      toolIds(sections, PLAIN_ROOT).filter((id) => id.startsWith("publish/")),
      [],
    );
  });

  it("owns a dispatch service when only a profile declares dispatch", async () => {
    const sections = await boot({
      workspaces: [{
        path: DISPATCH_ROOT,
        dispatch: { roots: [`${HOME}/worktrees`] },
      }],
    });
    // The boot config plans nothing: every turn that may dispatch passes its
    // own workspace's section, and the fallback is never used to plan a child.
    assert.deepStrictEqual(sections.dispatch?.roots, []);
    assert.deepStrictEqual(
      sections.workspaceConfig.resolve(DISPATCH_ROOT).dispatch?.roots,
      [`${HOME}/worktrees`],
    );
    assert.strictEqual(
      sections.workspaceConfig.resolve(PLAIN_ROOT).dispatch,
      null,
    );
  });

  it("owns no tool ports at all when no profile declares a section either", async () => {
    const sections = await boot({
      workspaces: [{ path: PLAIN_ROOT, trust_instructions: true }],
    });
    assert.strictEqual(sections.gate, undefined);
    assert.strictEqual(sections.publish, undefined);
    assert.strictEqual(sections.dispatch, undefined);
    assert.deepStrictEqual(
      toolIds(sections, PLAIN_ROOT).filter((id) =>
        id.startsWith("gate/") || id.startsWith("publish/")
      ),
      [],
    );
  });
});

describe("workspace profiles: the composed run policy", () => {
  it("admits every profile program at boot, tagged workspace-config", () => {
    const configured = profiles({
      workspaces: [{
        path: GATE_ROOT,
        gate: { command: ["npm", "test"], fast_command: ["npm", "run", "test:fast"] },
        publish: {
          pre_gate: ["./scripts/pre-gate"],
          gate: ["./scripts/gate", "--range={range}"],
        },
      }],
    });
    const programs = workspaceProfilePrograms(configured);
    assert.deepStrictEqual(programs, [
      "npm",
      "./scripts/pre-gate",
      "./scripts/gate",
    ]);
    const grants = composeRuntimeGrants({ workspacePrograms: programs });
    const byEntry = new Map(
      grants.run.map((grant) => [grant.entry, grant.sources]),
    );
    assert.deepStrictEqual(
      byEntry.get("npm")?.map((source) => source.kind),
      ["workspace-config"],
      "a profile's gate program is granted by the operator's own config",
    );
    assert.deepStrictEqual(
      byEntry.get("./scripts/gate")?.map((source) => source.kind),
      ["workspace-config"],
    );
  });

  it("grants nothing extra for a config with no profiles", () => {
    const grants = composeRuntimeGrants({
      workspacePrograms: workspaceProfilePrograms(profiles({})),
    });
    assert.ok(
      !grants.run.some((grant) =>
        grant.sources.some((source) => source.kind === "workspace-config")
      ),
    );
  });
});
