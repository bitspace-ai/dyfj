// BIT-662 acceptance checks 1-4, 6 and 7, against the real srt sandbox
// through the bash, git and write tools. Check 5 (the dyfj repository's own
// `npm ci` and `npm run test:fast`) needs the network and minutes, so it is
// the opt-in `npm run test:sandbox-acceptance` (scripts/sandbox-acceptance.ts).
//
// The suite skips, saying why, where srt cannot run: an unsupported platform
// or a missing dependency (bubblewrap, socat or ripgrep on Linux). Where srt
// can run, a failed boot probe fails the suite. Every check has run on macOS;
// none has run on Linux yet.
//
// Fixture: a repository with two linked worktrees ("session", "other"), set
// up host-side with git's global and system config switched off, and a fake
// home directory that holds the credential canaries, so no real credential
// path is read. Nothing here needs the network: refused connects are to a
// local listener, a local Unix socket, or a domain srt's proxy refuses
// without resolving it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { nestedSandboxSkipReason } from "../../../testing/nested-sandbox.ts";
import type { CommandCall } from "../definition.ts";
import { RootAnchors } from "./root-anchors.ts";
import { defineBash } from "./exec.ts";
import { defineEditFile, defineWriteFile } from "./file.ts";
import { defineGit } from "./git.ts";
import { bootSandbox, type CommandSandbox, shellQuote } from "./srt-sandbox.ts";
import { listenLoopbackProbe } from "../../transport/mod.ts";

const deps = SandboxManager.isSupportedPlatform()
  ? SandboxManager.checkDependencies()
  : { errors: [`unsupported platform (${process.platform})`] };
// A test that starts its own sandbox cannot run inside another one: the reason
// is the skip, so the run shows why these checks did not run.
const nested = nestedSandboxSkipReason();
const skip = deps.errors.length > 0
  ? `srt cannot run here: ${deps.errors.join("; ")}`
  : nested ?? false;
// node:test does not count the tests of a skipped suite, so one explicit
// skipped test carries the reason into the run's "skipped" count.
if (deps.errors.length === 0 && nested !== undefined) {
  it("starts a sandbox of its own", { skip: nested }, () => {});
}

let base = "";
let home = "";
let main = "";
let G = "";
let W = "";
let sandbox: CommandSandbox;
let env: MapEnv;

function hostGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

const call = (commandId: string, args: Record<string, unknown>): CommandCall => ({
  commandId,
  callId: "c1",
  caller: { principalId: "model", principalType: "agent" },
  arguments: args,
});

/** Runs `command` through the bash tool in workspace `root`. */
async function bash(command: string, root = W): Promise<string> {
  const tool = defineBash(root, { env, sandbox });
  return String(
    await tool.executor(call("bash", { command }), { authzBasis: "policy:allow:sandboxed" }),
  );
}

// Seatbelt reports a refused write as "Operation not permitted"; bubblewrap's
// read-only binds report "Read-only file system", and its hidden paths
// "Permission denied".
const refused = (out: string) =>
  !out.startsWith("exit 0") &&
  /Operation not permitted|Read-only file system|Permission denied/.test(out);

describe("the srt sandbox (BIT-662 acceptance)", { skip }, () => {
  before(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "srt-acceptance-")));
    home = join(base, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_canary"), "synthetic-canary\n");
    writeFileSync(join(home, "notes.txt"), "readable\n");
    mkdirSync(join(home, ".example-tool"));
    writeFileSync(join(home, ".example-tool", "token"), "synthetic-config-canary\n");
    main = join(base, "main");
    G = join(main, ".git");
    W = join(base, "wt-session");
    mkdirSync(main);
    hostGit(main, "init", "-q", "-b", "main");
    hostGit(main, "config", "user.name", "probe");
    hostGit(main, "config", "user.email", "probe@example.invalid");
    hostGit(main, "config", "commit.gpgsign", "false");
    hostGit(main, "config", "gc.auto", "0");
    writeFileSync(join(main, "f.txt"), "base\n");
    hostGit(main, "add", "f.txt");
    hostGit(main, "commit", "-q", "-m", "base");
    hostGit(main, "branch", "session");
    hostGit(main, "branch", "other");
    // Pack the base history, as a long-lived repository's would be.
    hostGit(main, "gc", "-q");
    hostGit(main, "worktree", "add", "-q", W, "session");
    hostGit(main, "worktree", "add", "-q", join(base, "wt-other"), "other");
    env = new MapEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home });
    sandbox = await bootSandbox({
      listenProbe: listenLoopbackProbe,
      env,
      home,
      denyRead: [".example-tool/token"],
    });
    assert.equal(
      sandbox.status.state,
      "on",
      `the boot probe failed: ${JSON.stringify(sandbox.status)}`,
    );
  });

  after(async () => {
    await SandboxManager.reset();
    rmSync(base, { recursive: true, force: true });
  });

  describe("check 1: the network", () => {
    it("a sandboxed connect to a host outside the allowlist is refused by the OS", async () => {
      let accepted = false;
      const listener: Server = createServer((socket) => {
        accepted = true;
        socket.destroy();
      });
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const port = (listener.address() as { port: number }).port;
      try {
        // A direct connect, around the proxy: Seatbelt (or bubblewrap's
        // network namespace) refuses it. The listener proves no connection
        // arrived; product code is not on this path.
        const out = await bash(`exec 3<>/dev/tcp/127.0.0.1/${port}`);
        assert.ok(!out.startsWith("exit 0"), out);
        assert.equal(accepted, false, "the connection reached the listener");
      } finally {
        listener.close();
      }
    });

    it("a domain outside the allowlist is refused by the sandbox's proxy", async () => {
      const out = await bash("curl -sS -m 20 -o /dev/null https://example.com/");
      assert.ok(!out.startsWith("exit 0"), out);
      assert.match(out, /403|CONNECT tunnel failed/);
    });
  });

  describe("check 2: writes outside the worktree and into shared git state", () => {
    const cases: [string, () => string][] = [
      ["outside the worktree (a sibling directory)", () => `echo x > ${shellQuote(join(base, "outside.txt"))}`],
      ["outside the worktree (the home directory)", () => `echo x > ${shellQuote(join(home, "planted"))}`],
      ["the main checkout's files", () => `echo x >> ${shellQuote(join(main, "f.txt"))}`],
      ["another branch's ref", () => `echo 0 > ${shellQuote(join(G, "refs", "heads", "other"))}`],
      ["another worktree's metadata", () => `echo x > ${shellQuote(join(G, "worktrees", "wt-other", "HEAD"))}`],
      [".git/hooks", () => `echo x > ${shellQuote(join(G, "hooks", "pre-commit"))}`],
      [".git/config", () => `echo x >> ${shellQuote(join(G, "config"))}`],
    ];
    for (const [name, command] of cases) {
      it(`a sandboxed write to ${name} is refused`, async () => {
        const out = await bash(command());
        assert.ok(refused(out), out);
      });
    }

    it("git update-ref on another branch is refused", async () => {
      const before = hostGit(main, "rev-parse", "other");
      const out = await bash("git update-ref refs/heads/other HEAD");
      assert.ok(!out.startsWith("exit 0"), out);
      assert.equal(hostGit(main, "rev-parse", "other"), before);
    });

    it("retargeting HEAD to another branch does not make that branch writable on the next call", async () => {
      // Pin the session branch first, as any earlier call would.
      assert.match(await bash("true"), /^exit 0/);
      const before = hostGit(main, "rev-parse", "other");
      // A residual: the worktree's own HEAD is writable.
      assert.match(await bash("git symbolic-ref HEAD refs/heads/other"), /^exit 0/);
      try {
        const out = await bash(`echo 0 > ${shellQuote(join(G, "refs", "heads", "other"))}`);
        assert.ok(refused(out), out);
        const commit = await bash("git commit -q --allow-empty -m via-other");
        assert.ok(!commit.startsWith("exit 0"), commit);
        assert.equal(hostGit(main, "rev-parse", "other"), before);
      } finally {
        hostGit(W, "symbolic-ref", "HEAD", "refs/heads/session");
      }
    });

    it("a .git pointer planted in a workspace that had no repository grants nothing on the next call", async () => {
      const plain = join(base, "plain");
      mkdirSync(plain);
      const other = join(G, "worktrees", "wt-other");
      const headBefore = readFileSync(join(other, "HEAD"), "utf8");
      // The first call pins the layout: no repository.
      assert.match(await bash("true", plain), /^exit 0/);
      assert.match(
        await bash(`echo ${shellQuote(`gitdir: ${other}`)} > .git`, plain),
        /^exit 0/,
      );
      const out = await bash(`echo planted > ${shellQuote(join(other, "HEAD"))}`, plain);
      assert.ok(refused(out), out);
      assert.equal(readFileSync(join(other, "HEAD"), "utf8"), headBefore);
    });

    it("the shared packfiles and the object store's info directory cannot be deleted or replaced", async () => {
      const pack = join(G, "objects", "pack");
      const files = readdirSync(pack);
      assert.ok(files.some((f) => f.endsWith(".pack")), "the fixture has a packfile");
      for (const command of [
        `rm -f ${shellQuote(pack)}/*`,
        `echo x > ${shellQuote(join(pack, files.find((f) => f.endsWith(".idx"))!))}`,
        `echo x > ${shellQuote(join(pack, "planted.pack"))}`,
        `mkdir -p ${shellQuote(join(G, "objects", "info"))} && echo /tmp/evil > ${shellQuote(join(G, "objects", "info", "alternates"))}`,
      ]) {
        const out = await bash(command);
        assert.ok(refused(out), `${command}\n${out}`);
      }
      assert.deepEqual(readdirSync(pack), files);
      execFileSync("git", ["-C", main, "fsck", "--no-dangling"]);
    });

    it("git config --local is refused", async () => {
      const out = await bash("git config --local probe.planted 1");
      assert.ok(!out.startsWith("exit 0"), out);
      assert.doesNotMatch(readFileSync(join(G, "config"), "utf8"), /planted/);
    });

    it("a sandboxed write inside the worktree is allowed", async () => {
      const out = await bash("echo inside > inside.txt");
      assert.match(out, /^exit 0/);
      assert.equal(readFileSync(join(W, "inside.txt"), "utf8"), "inside\n");
      rmSync(join(W, "inside.txt"));
    });
  });

  describe("check 3: credential paths", () => {
    it("a sandboxed read of a listed credential path is refused", async () => {
      const out = await bash(`cat ${shellQuote(join(home, ".ssh", "id_canary"))}`);
      assert.ok(refused(out), out);
      assert.doesNotMatch(out, /synthetic-canary/);
    });

    it("a path added with [sandbox] deny_read is refused too", async () => {
      const out = await bash(`cat ${shellQuote(join(home, ".example-tool", "token"))}`);
      assert.ok(refused(out), out);
      assert.doesNotMatch(out, /synthetic-config-canary/);
    });

    it("a file not on the list stays readable (the control)", async () => {
      const out = await bash(`cat ${shellQuote(join(home, "notes.txt"))}`);
      assert.match(out, /^exit 0\nreadable/);
    });
  });

  describe("check 4: commits", () => {
    it("git commit in a linked worktree succeeds through the git tool", async () => {
      const git = defineGit(W, { env, sandbox });
      writeFileSync(join(W, "f.txt"), "change\n");
      const added = String(await git.executor(
        call("git", { subcommand: "add", paths: ["f.txt"] }),
        { authzBasis: "policy:allow:sandboxed" },
      ));
      assert.match(added, /^exit 0/, added);
      const committed = String(await git.executor(
        call("git", { subcommand: "commit", message: "sandboxed commit" }),
        { authzBasis: "policy:allow:sandboxed" },
      ));
      assert.match(committed, /^exit 0/, committed);
      assert.equal(hostGit(main, "log", "-1", "--format=%s", "session"), "sandboxed commit");
      execFileSync("git", ["-C", main, "fsck", "--no-dangling"]);
    });

    it("write_file in the worktree runs in the sandbox and succeeds", async () => {
      const anchors = new RootAnchors();
      const write = defineWriteFile(anchors.root(W), { env, sandbox });
      const out = String(await write.executor(
        call("write_file", { path: "written.txt", content: "via sandbox\n" }),
        { authzBasis: "policy:allow:sandboxed" },
      ));
      assert.equal(out, "wrote written.txt");
      assert.equal(readFileSync(join(W, "written.txt"), "utf8"), "via sandbox\n");
    });

    it("edit_file in the worktree runs in the sandbox and succeeds", async () => {
      const anchors = new RootAnchors();
      const edit = defineEditFile(anchors.root(W), { env, sandbox });
      const out = String(await edit.executor(
        call("edit_file", { path: "written.txt", old_string: "via", new_string: "edited in the" }),
        { authzBasis: "policy:allow:sandboxed" },
      ));
      assert.match(out, /^(wrote|edited) written\.txt/, out);
      assert.equal(readFileSync(join(W, "written.txt"), "utf8"), "edited in the sandbox\n");
    });

    it("in a main checkout, git commit is refused with a message to use a worktree", async () => {
      const git = defineGit(main, { env, sandbox });
      const out = String(await git.executor(
        call("git", { subcommand: "commit", message: "from main" }),
        { authzBasis: "policy:allow:sandboxed" },
      ));
      assert.match(out, /^error: refusing to run git commit in the sandbox/);
      assert.match(out, /Sandboxed commits need a linked worktree: use a worktree\./);
    });

    it("in a main checkout, a commit through bash fails with the same note", async () => {
      writeFileSync(join(main, "g.txt"), "x\n");
      const out = await bash("git add g.txt && git commit -qm from-bash", main);
      assert.ok(!out.startsWith("exit 0"), out);
      assert.match(out, /use a worktree/);
    });
  });

  describe("check 6: the publishing route", () => {
    it("a Unix socket like the gh-app broker's is unreachable", async () => {
      const path = join(base, "broker.sock");
      let accepted = false;
      const server = createServer((socket) => {
        accepted = true;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      try {
        const script = `require("net").connect(${JSON.stringify(path)})` +
          `.on("connect",()=>process.exit(0))` +
          `.on("error",(e)=>{console.error(e.code);process.exit(3)})`;
        const out = await bash(`node -e ${shellQuote(script)}`);
        assert.ok(!out.startsWith("exit 0"), out);
        assert.equal(accepted, false, "the connection reached the socket");
      } finally {
        server.close();
      }
    });

    it("github.com is unreachable", async () => {
      const out = await bash("curl -sS -m 20 -o /dev/null https://github.com/");
      assert.ok(!out.startsWith("exit 0"), out);
      assert.match(out, /403|CONNECT tunnel failed/);
    });
  });

  describe("check 7: the gitdir pointer files", () => {
    const meta = () => join(G, "worktrees", "wt-session");
    const cases: [string, () => string][] = [
      ["the worktree's .git file", () => `echo 'gitdir: /tmp/evil' > .git`],
      ["the worktree's .git file, by rename", () => `echo 'gitdir: /tmp/evil' > p && mv p .git`],
      ["commondir", () => `echo /tmp/evil > ${shellQuote(join(meta(), "commondir"))}`],
      ["gitdir", () => `echo /tmp/evil/.git > ${shellQuote(join(meta(), "gitdir"))}`],
      ["config.worktree", () => `printf '[core]\\n\\tfsmonitor = /tmp/evil\\n' > ${shellQuote(join(meta(), "config.worktree"))}`],
    ];
    for (const [name, command] of cases) {
      it(`a sandboxed write to ${name} is refused`, async () => {
        const out = await bash(command());
        assert.ok(refused(out), out);
      });
    }

    it("the pointer files are unchanged afterwards", () => {
      assert.match(readFileSync(join(W, ".git"), "utf8"), /^gitdir: .*wt-session/);
      assert.equal(existsSync(join(meta(), "config.worktree")), false);
      rmSync(join(W, "p"), { force: true });
    });
  });
});
