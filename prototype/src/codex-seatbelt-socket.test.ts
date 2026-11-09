// A canary for the Codex route (BIT-899): a command Codex runs in its
// sandbox cannot connect to the Workbench runtime's Unix socket. Whatever
// connects to that socket is the operator: it can answer approvals and stop
// the runtime. The route's environment has no DYFJ_SOCKET and an isolated
// HOME, so the default path is not found by accident; this checks that the
// seatbelt refuses the connect when the absolute path is known.
//
// The route starts Codex through codex-acp in `workspace-write` mode
// (INITIAL_AGENT_MODE, asserted by the Codex profile test in
// `external-agent-runtime.integration.test.ts`), whose sandbox policy is
// workspace-write with network access off. This canary does not go through
// codex-acp: `codex sandbox -c sandbox_mode="workspace-write"` runs one
// command under the pinned Codex executable's workspace-write sandbox, with
// network access at its default (off), without a model or a sign-in. A Codex
// home of the test's own, laid out like the route's, keeps every real runner
// home out of it. A command the model asks to run outside the sandbox is a
// different path: it needs the operator's approval.
//
// Each case has a control: the same client, at the same socket, run under the
// same sandbox with network access on, must connect. nc exits 1 silently
// whatever the cause, so its control is what shows it could connect; node
// must also report the sandbox's EPERM.
//
// macOS only: there Codex's sandbox is Seatbelt, which the route uses. Codex's
// Linux sandbox is not checked here.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { MapEnv } from "../testing/fakes/map-env.ts";
import { nestedSandboxSkipReason } from "../testing/nested-sandbox.ts";
import { unixSocketBindSkip } from "../testing/unix-socket-bind.ts";
import { codexAcpPackageRoot, ownPrototypeRoot } from "./acp-adapter-package.ts";
import { CODEX_HOME_CONFIG_TOML } from "./codex-home-config.ts";
import { bundledCodexExecutable } from "./external-agent-runtime.ts";
import { ensureSocketDir, resolveSocketPath } from "./transport/mod.ts";

/** The sandbox the route asks Codex for. */
const ROUTE_SANDBOX = ["-c", 'sandbox_mode="workspace-write"'] as const;
/** The same sandbox opened up to the network: the control. */
const OPEN_SANDBOX = [
  ...ROUTE_SANDBOX,
  "-c",
  "sandbox_workspace_write.network_access=true",
] as const;

const CONNECT_SCRIPT = 'require("net").connect(process.argv[1])' +
  '.on("connect",()=>{console.log("CONNECTED");process.exit(0)})' +
  '.on("error",(e)=>{console.log("REFUSED",e.code);process.exit(3)})';

const skip = process.platform !== "darwin"
  ? "the Codex route's sandbox is checked on macOS (Seatbelt) only"
  : nestedSandboxSkipReason() ?? await unixSocketBindSkip() ?? false;

// node:test does not count the tests of a skipped suite, so one explicit
// skipped test carries the reason into the run's "skipped" count.
if (skip !== false) it("runs the Codex seatbelt canary", { skip }, () => {});

describe("the Codex route's sandbox refuses the runtime socket", { skip }, () => {
  // A short operator home: the default socket path under it must fit the
  // Unix-socket path limit.
  let operatorHome = "";
  let runnerHome = "";
  let codexHome = "";
  let workspace = "";
  let codex = "";

  before(async () => {
    operatorHome = realpathSync(mkdtempSync("/tmp/dyfj-cx-"));
    runnerHome = join(operatorHome, ".dyfj", "runner-homes", "codex-chatgpt", "home");
    codexHome = join(runnerHome, ".codex");
    workspace = join(operatorHome, "ws");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    writeFileSync(join(codexHome, "config.toml"), CODEX_HOME_CONFIG_TOML, { mode: 0o600 });
    codex = await bundledCodexExecutable(await codexAcpPackageRoot(ownPrototypeRoot()));
  });

  after(() => rmSync(operatorHome, { recursive: true, force: true }));

  /** Runs `argv` under Codex's sandbox in the workspace, as the route's shell would. */
  function sandboxed(sandbox: readonly string[], argv: readonly string[]): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [codex, "sandbox", ...sandbox, "--", ...argv],
        {
          cwd: workspace,
          env: {
            HOME: runnerHome,
            CODEX_HOME: codexHome,
            PATH: "/usr/bin:/bin",
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          resolve(`exit ${error === null ? 0 : (error.code ?? "?")}\n${stdout}${stderr}`);
        },
      );
    });
  }

  /** Listens on `path`, runs `attempt`, and says whether anything connected. */
  async function reached(path: string, attempt: () => Promise<string>) {
    ensureSocketDir(path);
    let accepted = false;
    const server: Server = createServer((socket) => {
      accepted = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const out = await attempt();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { accepted, out };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path, { force: true });
    }
  }

  const clients: [string, (path: string) => string[], RegExp | null][] = [
    ["node", (path) => [process.execPath, "-e", CONNECT_SCRIPT, path], /REFUSED EPERM/],
  ];
  if (existsSync("/usr/bin/nc")) {
    clients.push(["nc -U", (path) => ["/usr/bin/nc", "-U", path], null]);
  }
  const places: [string, () => string][] = [
    ["the default path under the operator home", () =>
      resolveSocketPath(new MapEnv({ HOME: operatorHome }))],
    ["a socket inside the writable workspace", () => join(workspace, "w.sock")],
  ];

  for (const [place, socketPath] of places) {
    for (const [client, argv, refusal] of clients) {
      it(`${client} connects to ${place} when the sandbox allows the network (the control)`, async () => {
        const path = socketPath();
        const { accepted, out } = await reached(path, () => sandboxed(OPEN_SANDBOX, argv(path)));
        assert.equal(accepted, true, out);
      });

      it(`${client} cannot connect to ${place}`, async () => {
        const path = socketPath();
        const { accepted, out } = await reached(path, () => sandboxed(ROUTE_SANDBOX, argv(path)));
        assert.ok(!out.startsWith("exit 0"), out);
        if (refusal !== null) assert.match(out, refusal);
        assert.equal(accepted, false, `the sandboxed command reached the socket:\n${out}`);
      });
    }
  }
});
