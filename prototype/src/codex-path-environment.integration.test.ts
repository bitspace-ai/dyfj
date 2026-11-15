import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MapEnv } from "../testing/fakes/map-env.ts";
import { loadConfig } from "./config/workbench.ts";
import { codexChatGptProfile, type CodexChatGptProfileOptions, runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import { canonicalExecutionProfileDigest } from "./acp-session-map.ts";
import { composeCodexPath } from "./codex-runner-bin.ts";
import { MemoryStore } from "./store/mod.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-path-")));
  const home = join(root, "operator");
  await mkdir(home, { mode: 0o700 });
  for (const [name, content] of [
    ["node_modules/@agentclientprotocol/codex-acp/package.json", '{"version":"2.5.0"}'],
    ["node_modules/@agentclientprotocol/codex-acp/dist/index.js", ""],
    ["node_modules/@openai/codex/bin/codex.js", ""], ["node", ""],
  ]) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o700 });
  }
  const env = new MapEnv({ HOME: home, DYFJ_NODE_PATH: join(root, "node"), USER: "fixture", PATH: "" });
  const bin = join(home, ".dyfj/runner-homes/codex-chatgpt/bin");
  const dir = async (name: string, mode = 0o700) => {
    const path = join(root, name); await mkdir(path, { recursive: true }); await chmod(path, mode); return path;
  };
  const build = (options: CodexChatGptProfileOptions = {}) => codexChatGptProfile(root, {
    home, nodePath: join(root, "node"), prototypeRoot: root, toolchainPath: "", env, ...options,
  });
  return { root, home, env, bin, dir, build };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function check(name: string, run: (f: Fixture) => Promise<void>) {
  test(name, async () => { const f = await fixture(); try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); } });
}
check("1 operator PATH retains five directories in order", async f => {
  const dirs = await Promise.all([1,2,3,4,5].map(n => f.dir(`bin${n}`)));
  f.env.set("PATH", dirs.join(":"));
  assert.equal((await f.build()).environment.PATH, [f.bin, ...dirs, "/usr/bin", "/bin"].join(":"));
});
check("2 toolchain precedes operator and two extra directories", async f => {
  const [tool, operator, a, b] = await Promise.all(["tool", "operator-bin", "a", "b"].map(n => f.dir(n)));
  f.env.set("PATH", operator);
  assert.equal((await f.build({ toolchainPath: tool, extraPath: [a,b] })).environment.PATH, [f.bin, tool, operator, a,b,"/usr/bin","/bin"].join(":"));
});
check("3 duplicate symlink and empty entries are omitted", async f => {
  const dir = await f.dir("tools"); const alias = join(f.root,"alias"); await symlink(dir, alias);
  f.env.set("PATH", `${dir}:${alias}::${dir}`);
  const p = await f.build(); assert.equal(p.environment.PATH, `${f.bin}:${dir}:/usr/bin:/bin`);
  assert.equal(p.pathEvidence?.operatorDirectories, 1);
});
check("4 invalid runtime directories are dropped and counted", async f => {
  const world = await f.dir("world",0o777); const colon = await f.dir("with:colon");
  const alias = join(f.root,"alias"); await symlink(colon,alias);
  const file = join(f.root,"file"); await writeFile(file,"file");
  f.env.set("PATH", [join(f.root,"missing"),"relative",`${f.root}/../other`,file,world,alias].join(":"));
  const p = await f.build(); assert.equal(p.environment.PATH, `${f.bin}:/usr/bin:/bin`);
  assert.equal(p.pathEvidence?.operatorDropped,6);
});
check("5 group writable operator directory is accepted", async f => {
  const dir = await f.dir("group",0o775); f.env.set("PATH",dir);
  assert.equal((await f.build()).environment.PATH,`${f.bin}:${dir}:/usr/bin:/bin`);
});
check("6 minimal preserves the old environment and ignores extras", async f => {
  f.env.set("PATH", await f.dir("operator-bin"));
  const p = await f.build({ path: "minimal", extraPath: [await f.dir("extra")] });
  assert.equal(p.environment.PATH,`${f.bin}:/usr/bin:/bin`);
  assert.equal(p.pathEvidence?.operatorDirectories,0); assert.equal(p.pathEvidence?.extraDirectories,0);
  assert.deepEqual(Object.keys(p.environment).sort(),["HOME","CODEX_HOME","CODEX_PATH","CARGO_HOME","NO_BROWSER","INITIAL_AGENT_MODE","PATH","CODEX_CONFIG","USER"].sort());
  assert.equal(p.environment.USER,"fixture");
});
check("7.1 unavailable extras are dropped without failing the profile", async f => {
  const p = await f.build({ extraPath: [join(f.root,"missing"),await f.dir("world",0o777)] });
  assert.equal(p.environment.PATH,`${f.bin}:/usr/bin:/bin`); assert.equal(p.pathEvidence?.extraDropped,2);
});
check("8 shell profiles quote the child PATH with spaces and quotes", async f => {
  const dir = await f.dir("a space and 'quote"); f.env.set("PATH",dir);
  const p = await f.build();
  for (const name of [".zprofile",".bash_profile"]) {
    assert.equal(await readFile(join(p.environment.HOME,name),"utf8"),`export PATH='${f.bin}:${dir.replaceAll("'", `'"'"'`)}:/usr/bin:/bin'\n`);
  }
});
check("9 Rustup defaults to acceptable operator home and explicit selection wins", async f => {
  assert.equal((await f.build()).environment.RUSTUP_HOME,undefined);
  await mkdir(join(f.home,".rustup"),{mode:0o700});
  assert.equal((await f.build()).environment.RUSTUP_HOME,join(f.home,".rustup"));
  const explicit = await f.dir("explicit-rustup"); f.env.set("DYFJ_CODEX_RUSTUP_HOME",explicit);
  assert.equal((await f.build()).environment.RUSTUP_HOME,explicit);
  f.env.delete("DYFJ_CODEX_RUSTUP_HOME"); await chmod(join(f.home,".rustup"),0o777);
  assert.equal((await f.build()).environment.RUSTUP_HOME,undefined);
});
check("10 only present allowlisted environment names reach the child", async f => {
  f.env.set("EDITOR","fixture-editor"); f.env.set("UNLISTED","not passed");
  const p = await f.build({ envAllow: ["EDITOR","ABSENT"] });
  assert.equal(p.environment.EDITOR,"fixture-editor"); assert.equal(p.environment.ABSENT,undefined); assert.equal(p.environment.UNLISTED,undefined);
  assert.equal(p.pathEvidence?.environmentNamesAdded,1);
});
check("12 receipt reports all sources with counts only", async f => {
  const toolchainPath = await f.dir("tool"); f.env.set("PATH",await f.dir("operator-bin")); f.env.set("EDITOR","private-value");
  const p = await f.build({ toolchainPath, extraPath: [await f.dir("extra"),join(f.root,"missing")], envAllow:["EDITOR"] });
  const result = await runExternalAgentWorkbenchRuntime({ mode:"turn",prompt:"fixture",routingOptions:{},runner:{kind:"acp",profile:"codex-chatgpt"},workspaceRoot:f.root,trustWorkspaceInstructions:true },{
    store:new MemoryStore(),resolveProfile:()=>p,runAgent:async()=>({text:"fixture",stopReason:"stop",capabilities:[],elapsedMs:1}),
  });
  assert.ok(result.receipt.includes("Toolchain directories: 1\nOperator PATH directories: 1 (0 dropped)\nExtra PATH directories: 1 (1 dropped)\nEnvironment names added: 1"));
  assert.ok(!result.receipt.includes("EDITOR")); assert.ok(!result.receipt.includes("private-value"));
});
check("13 profile PATH changes invalidate retained session digest", async f => {
  const a = await f.build(); f.env.set("PATH",await f.dir("another")); const b = await f.build();
  assert.notEqual(canonicalExecutionProfileDigest(a),canonicalExecutionProfileDigest(b));
});
check("14.1 shared writable operator codex directory suppresses instructions", async f => {
  const codex = join(f.home,".codex"); await mkdir(codex,{mode:0o700}); await writeFile(join(codex,"AGENTS.md"),"instructions",{mode:0o600}); await chmod(codex,0o770);
  assert.deepEqual((await f.build()).operatorContext,[]);
});
const config = (body: string) => loadConfig({ env:new MapEnv({ HOME:"/fixture" }),readTextFile:async()=>`[codex]\n${body}` });
for (const value of ["relative/path", "/private/../bad", "/private/colon:value", "/private/comma,value", "/private/./dot"]) {
  test(`7.2 config rejects extra_path position for ${value}`,async()=> {
    await assert.rejects(config(`extra_path = [${JSON.stringify(value)}]`),error=>error instanceof Error && error.message.startsWith("config:") && error.message.includes("extra_path") && error.message.includes("1") && !error.message.includes(value));
  });
}
for (const name of ["HOME", "CODEX_OTHER", "DYFJ_OTHER", "SSH_AUTH_SOCK", "lower_token", "API_KEY", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"]) {
  test(`11 config refuses env_allow ${name}`,async()=> {
    await assert.rejects(config(`env_allow = [${JSON.stringify(name)}]`),error=>error instanceof Error && error.message.startsWith("config:") && error.message.includes(name));
  });
}
test("config validates path mode and array bounds",async()=> {
  await assert.rejects(config('path = "unknown"'),/config:.*path/);
  await assert.rejects(config(`extra_path = ${JSON.stringify(Array(17).fill("/tmp"))}`),/config:.*extra_path/);
  await assert.rejects(config(`env_allow = ${JSON.stringify(Array(33).fill("EDITOR"))}`),/config:.*env_allow/);
});

check("14.2 config reaches profile through server and engine", async f => {
  const { serveWorkbenchUnix } = await import("./server/main.ts");
  const engineConfig = await loadConfig({ env:f.env, readTextFile:async()=> '[codex]\noperator_context = false\npath = "minimal"\nenv_allow = ["EDITOR"]\nworkbench_tools = false' });
  await mkdir(join(f.home,".codex"),{mode:0o700});
  await writeFile(join(f.home,".codex/AGENTS.md"),"must not project",{mode:0o600});
  f.env.set("EDITOR","fixture-editor");
  const socketHost = { listen: async () => ({ accept: () => new Promise<null>(resolve => { finish = resolve; }), close: () => finish?.(null) }), connect: async () => { throw new Error("unused"); } };
  let finish: ((value: null) => void) | undefined;
  let captured = false;
  const server = await serveWorkbenchUnix(join(f.root,"server.sock"), {
    store: new MemoryStore(), env:f.env, engineConfig: { ...engineConfig, trustWorkspaceInstructions:true }, socketHost,
    runRuntime: async input => {
      // Fail before profile construction when the boundary loses config.
      assert.equal(input.codexPath,"minimal");
      assert.equal(input.codexOperatorContext,false);
      return await runExternalAgentWorkbenchRuntime({ ...input, runner:{kind:"acp",profile:"codex-chatgpt"}, routingOptions:input.routingOptions ?? {} }, {
        store:new MemoryStore(), env:f.env,
        runAgent:async ({profile}) => {
          captured = true; assert.deepEqual(profile.operatorContext,[]);
          assert.equal(profile.environment.EDITOR,"fixture-editor");
          assert.equal(profile.environment.PATH,`${f.bin}:/usr/bin:/bin`);
          return {text:"fixture",stopReason:"stop",capabilities:[],elapsedMs:1};
        },
      });
    },
  });
  try {
    const turn = server.startHeadlessTurn({prompt:"fixture", workspace:f.root});
    assert.ok(!("error" in turn)); await turn.result; assert.equal(captured,true);
  } finally { await server.close(); }
});
test("7.3 runtime reports each dropped-extra count once without paths",async()=> {
  const { codexExtraPathReporter } = await import("./codex-runner-bin.ts");
  const lines: string[] = []; const report = codexExtraPathReporter(line=>lines.push(line));
  for (const count of [0,2,2,1,2,0,1]) report(count);
  assert.deepEqual(lines,["Codex extra PATH directories dropped: 2","Codex extra PATH directories dropped: 1"]);
  const other: string[] = []; codexExtraPathReporter(line=>other.push(line))(2);
  assert.deepEqual(other,["Codex extra PATH directories dropped: 2"]);
});

for (const name of ["NODE_OPTIONS", "node_options", "BASH_ENV", "bash_env", "ENV", "env", "LD_PRELOAD", "ld_preload", "DYLD_INSERT_LIBRARIES", "dyld_insert_libraries"]) {
  test(`env_allow refuses process-loading name ${name}`, async () => {
    await assert.rejects(config(`env_allow = [${JSON.stringify(name)}]`), error =>
      error instanceof Error && error.message.startsWith("config:") && error.message.includes(name));
  });
}
for (const entry of ["NAME=value", "BAD-NAME"]) {
  test(`env_allow hides invalid entry ${entry}`, async () => {
    await assert.rejects(config(`env_allow = [${JSON.stringify(entry)}]`), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /config:.*env_allow.*entry 1/);
      for (const part of entry.split("=")) assert.ok(!error.message.includes(part), "diagnostic echoed invalid entry text");
      return true;
    });
  });
}

check("fixed PATH entries stay last and do not count toward either source", async f => {
  const first = await f.dir("first");
  const second = await f.dir("second");
  const extra = await f.dir("extra");
  const result = await composeCodexPath({
    minimalPath: `${f.bin}:/usr/bin:/bin`,
    mode: "operator",
    runtimePath: `${first}:/usr/bin:${second}:/bin`,
    extraPath: ["/usr/bin", extra, "/bin"],
  });
  assert.equal(result.path, `${f.bin}:${first}:${second}:${extra}:/usr/bin:/bin`);
  assert.deepEqual(result.evidence, {
    operatorDirectories: 2, operatorDropped: 0,
    extraDirectories: 1, extraDropped: 0, environmentNamesAdded: 0,
  });
});

check("symbolic-link duplicates share the fixed-entry exclusion and source counts", async f => {
  const directory = await f.dir("tools");
  const extra = await f.dir("extra");
  const alias = join(f.root, "tools-link");
  const fixedAlias = join(f.root, "system-bin-link");
  await symlink(directory, alias);
  await symlink("/usr/bin", fixedAlias);
  const result = await composeCodexPath({
    minimalPath: `${f.bin}:/usr/bin:/bin`,
    mode: "operator",
    runtimePath: `${fixedAlias}:${directory}:${alias}:/bin`,
    extraPath: [alias, fixedAlias, extra],
  });
  assert.equal(result.path, `${f.bin}:${directory}:${extra}:/usr/bin:/bin`);
  assert.deepEqual(result.evidence, {
    operatorDirectories: 1, operatorDropped: 0,
    extraDirectories: 1, extraDropped: 0, environmentNamesAdded: 0,
  });
});
