import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { codexChatGptProfile, runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import type { AcpExecutionProfile } from "./acp-client.ts";
import { canonicalExecutionProfileDigest } from "./acp-session-map.ts";
import { MemoryStore } from "./store/mod.ts";

async function snapshot(path: string): Promise<unknown> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return null;
  const metadata = { mode: info.mode, ino: info.ino, mtime: info.mtimeMs };
  if (info.isSymbolicLink()) return { ...metadata, link: await readlink(path) };
  if (info.isDirectory()) return { ...metadata, entries: await Promise.all((await readdir(path)).sort().map(async name => [name, await snapshot(join(path, name))])) };
  return { ...metadata, bytes: (await readFile(path)).toString("hex") };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "operator-context-"));
  const home = join(root, "operator");
  const privateHome = join(home, ".dyfj/runner-homes/codex-chatgpt/home");
  const source = join(home, ".codex/AGENTS.md");
  const skills = join(home, ".agents/skills");
  const copy = join(privateHome, ".codex/AGENTS.md");
  const link = join(privateHome, ".agents/skills");
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await mkdir(skills, { recursive: true, mode: 0o700 });
  await writeFile(source, "operator instructions\n", { mode: 0o600 });
  await writeFile(join(skills, "fixture.txt"), "skill fixture");
  for (const name of ["config.toml", "hooks.json", "auth.json", "memories", "skills/private.txt", "rules/saved.rules"]) {
    const path = join(home, ".codex", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not projected");
  }
  for (const [name, content] of [
    ["node_modules/@agentclientprotocol/codex-acp/package.json", '{"version":"2.5.0"}'],
    ["node_modules/@agentclientprotocol/codex-acp/dist/index.js", ""],
    ["node_modules/@openai/codex/bin/codex.js", ""],
    ["node", ""],
  ]) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o700 });
  }
  const trees = () => Promise.all([snapshot(join(home, ".codex")), snapshot(join(home, ".agents"))]);
  const build = async (operatorContext = true) => {
    const before = await trees();
    try {
      return await codexChatGptProfile(root, { home, prototypeRoot: root, nodePath: join(root, "node"), toolchainPath: "", rustupHome: "", operatorContext });
    } finally {
      assert.deepStrictEqual(await trees(), before, "operator trees unchanged");
    }
  };
  return { root, home, privateHome, source, skills, copy, link, build };
}

async function evidence(profile: AcpExecutionProfile, expected: string) {
  const result = await runExternalAgentWorkbenchRuntime({
    mode: "turn", prompt: "fixture", routingOptions: {},
    runner: { kind: "acp", profile: "codex-chatgpt" },
    workspaceRoot: profile.workspace, trustWorkspaceInstructions: true,
  }, {
    store: new MemoryStore(), resolveProfile: () => profile,
    runAgent: async () => ({ text: "fixture", stopReason: "stop", capabilities: [], elapsedMs: 1 }),
  });
  assert.ok(result.receipt.includes(`\nOperator context: ${expected}\n`), `missing Operator context: ${expected}`);
}

const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
  ["1 projects instructions and canonical skills with evidence", async f => {
    const original = f.skills + "-canonical";
    await mkdir(original, { mode: 0o700 });
    await rm(f.skills, { recursive: true });
    await symlink(original, f.skills);
    const p = await f.build();
    assert.equal(await readFile(f.copy, "utf8"), await readFile(f.source, "utf8"));
    assert.equal((await stat(f.copy)).mode & 0o777, 0o600);
    assert.equal(await readlink(f.link), await realpath(f.skills));
    await evidence(p, "instructions, skills");
  }],
  ["2 unchanged projection preserves inode and mtime", async f => {
    await f.build(); const before = await stat(f.copy);
    await f.build(); const after = await stat(f.copy);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  }],
  ["3 changed source refreshes copy", async f => {
    await f.build(); await writeFile(f.source, "updated"); await f.build();
    assert.equal(await readFile(f.copy, "utf8"), "updated");
  }],
  ["4 disabling removes projection and empty parent", async f => {
    await f.build();
    assert.ok((await lstat(f.copy)).isFile());
    const p = await f.build(false);
    assert.equal(await snapshot(f.copy), null); assert.equal(await snapshot(dirname(f.link)), null);
    await evidence(p, "none");
  }],
  ...(["instructions", "skills"] as const).map(kind => [`5 missing ${kind} removes only its projection`, async (f: Awaited<ReturnType<typeof fixture>>) => {
    await f.build();
    assert.ok((await lstat(f.copy)).isFile());
    await rm(kind === "instructions" ? f.source : f.skills, { recursive: true });
    const p = await f.build();
    assert.equal(await snapshot(kind === "instructions" ? f.copy : f.link), null);
    assert.ok(await lstat(kind === "instructions" ? f.link : f.copy));
    await evidence(p, kind === "instructions" ? "skills" : "instructions");
  }] as [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]),
  ...["writable", "oversize", "directory"].map(kind => [`6 rejects ${kind} instructions without failing profile`, async (f: Awaited<ReturnType<typeof fixture>>) => {
    if (kind === "writable") await chmod(f.source, 0o620);
    if (kind === "oversize") await writeFile(f.source, "x".repeat(65_537));
    if (kind === "directory") { await rm(f.source); await mkdir(f.source); }
    const p = await f.build(); assert.equal(await snapshot(f.copy), null); await evidence(p, "skills");
  }] as [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]),
  ...["writable", "file"].map(kind => [`7 rejects ${kind} skills without failing profile`, async (f: Awaited<ReturnType<typeof fixture>>) => {
    if (kind === "writable") await chmod(f.skills, 0o720);
    else { await rm(f.skills, { recursive: true }); await writeFile(f.skills, "file"); }
    const p = await f.build(); assert.equal(await snapshot(f.link), null); await evidence(p, "instructions");
  }] as [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]),
  ["8 replaces handmade copy and wrong skills link", async f => {
    await f.build(); await mkdir(dirname(f.link), { recursive: true, mode: 0o700 });
    await writeFile(f.copy, "handmade"); await rm(f.link, { force: true });
    await symlink(f.root, f.link); await f.build();
    assert.equal(await readFile(f.copy, "utf8"), "operator instructions\n");
    assert.equal(await readlink(f.link), await realpath(f.skills));
  }],
  ["9 preserves real skills directory and contents", async f => {
    await f.build(false); await mkdir(f.link, { recursive: true, mode: 0o700 });
    await writeFile(join(f.link, "keep"), "keep"); const before = await snapshot(f.link);
    const p = await f.build(); assert.deepStrictEqual(await snapshot(f.link), before);
    await evidence(p, "instructions"); await f.build(false);
    assert.deepStrictEqual(await snapshot(f.link), before);
  }],
  ["10 operator trees stay unchanged including excluded files", async f => {
    const p = await f.build(); await evidence(p, "instructions, skills");
    assert.equal(await snapshot(join(f.privateHome, ".codex/hooks.json")), null);
    assert.equal(await snapshot(join(f.privateHome, ".codex/skills")), null);
  }],
  ["session digest changes with projected kinds", async f => {
    const off = await f.build(false); const on = await f.build();
    assert.notEqual(canonicalExecutionProfileDigest(off), canonicalExecutionProfileDigest(on));
  }],
];
for (const [name, run] of cases) test(`operator context: ${name}`, async () => {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
});
