// The native bash route's read-only allowlist (`bash-allowlist.ts`) classifies
// each listed Unix-socket client form as "ask" (BIT-899). Whatever connects to
// the runtime's socket is the operator: it can answer approvals and stop the
// runtime. These checks cover the classifier, for the listed forms only: an
// allowlist change that admits a new command still needs its own review, and
// a call the operator approves is outside them. The allowlisted readers found
// on PATH are also run against a live socket, to check that none connects.
//
// The sandboxed route runs every command without a prompt; its proof is the
// srt check in `srt-sandbox.integration.test.ts`. The Codex route's proof is
// `codex-seatbelt-socket.test.ts`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { unixSocketBindSkip } from "../../../testing/unix-socket-bind.ts";
import { classifyReadOnlyBash } from "./bash-allowlist.ts";

// The socket sits inside the workspace, the case most favourable to an
// allowlisted command: every path check passes.
const SOCKET = "run/workbench.sock";

let base = "";
let root = "";

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bash-sock-")));
  root = join(base, "ws");
  mkdirSync(join(root, "run"), { recursive: true });
});

after(() => rmSync(base, { recursive: true, force: true }));

describe("the bash allowlist admits no Unix-socket client", () => {
  // Each is a program that can connect to a Unix socket, written in a form the
  // lexer accepts. The expected reason pins which rule refused it (the
  // command check, the git subcommand check or the pipe check), not a syntax
  // error.
  for (
    const [command, reason] of [
      ["dyfj", "the command `dyfj`"],
      ["dyfj exec hello", "the command `dyfj`"],
      ["dyfj --session s1", "the command `dyfj`"],
      [`nc -U ${SOCKET}`, "the command `nc`"],
      [`ncat -U ${SOCKET}`, "the command `ncat`"],
      [`netcat -U ${SOCKET}`, "the command `netcat`"],
      [`socat - UNIX-CONNECT:${SOCKET}`, "the command `socat`"],
      [`curl --unix-socket ${SOCKET} http://localhost/`, "the command `curl`"],
      [`node -e 'require("net").connect(process.argv[1])' ${SOCKET}`, "the command `node`"],
      [`python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])' ${SOCKET}`, "the command `python3`"],
      [`perl -MIO::Socket::UNIX -e 1 ${SOCKET}`, "the command `perl`"],
      [`ruby -rsocket -e 1 ${SOCKET}`, "the command `ruby`"],
      [`bash -c 'nc -U run/workbench.sock'`, "the command `bash`"],
      [`sh -c 'nc -U run/workbench.sock'`, "the command `sh`"],
      [`env nc -U ${SOCKET}`, "the command `env`"],
      [`command nc -U ${SOCKET}`, "the command `command`"],
      [`exec nc -U ${SOCKET}`, "the command `exec`"],
      [`nohup nc -U ${SOCKET}`, "the command `nohup`"],
      ["xargs nc -U", "the command `xargs`"],
      [`busybox nc -U ${SOCKET}`, "the command `busybox`"],
      ["npx dyfj", "the command `npx`"],
      ["npm exec dyfj", "the command `npm`"],
      ["ssh -o ProxyCommand=x host", "the command `ssh`"],
      [`cat ${SOCKET} && nc -U ${SOCKET}`, "the command `nc`"],
      ["git status; dyfj exec hello", "the command `dyfj`"],
      ["git -c core.pager=x status", "a git option or subcommand outside the read-only set"],
      ["git --exec-path=. status", "a git option or subcommand outside the read-only set"],
      [`git log | nc -U ${SOCKET}`, "a pipe to something other than"],
    ] as const
  ) {
    it(`asks for: ${command}`, () => {
      const verdict = classifyReadOnlyBash(command, root, root);
      assert.equal(verdict.allow, false, `auto-approved: ${command}`);
      assert.ok(
        !verdict.allow && verdict.why.includes(reason),
        `${command}: asked for another reason: ${!verdict.allow && verdict.why}`,
      );
    });
  }
});

const BASH_PATH = process.env.PATH ?? "/usr/bin:/bin";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `command` as the bash tool's native runner does, `bash -c` in `root`,
 * and returns its exit status (null when it was signalled or timed out).
 */
function runBash(command: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd: root,
        env: { PATH: BASH_PATH },
        timeout: 10_000,
      },
      (error, _stdout, stderr) =>
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stderr,
        }),
    );
  });
}

/** Whether `program` is an executable file on the PATH `runBash` uses. */
function onPath(program: string): boolean {
  return BASH_PATH.split(":").some((dir) =>
    dir !== "" && isExecutable(join(dir, program))
  );
}

const socketSkip = await unixSocketBindSkip();

describe("an allowlisted command pointed at a live socket does not connect", {
  skip: socketSkip ?? false,
}, () => {
  let server: Server;
  let accepted = 0;

  before(async () => {
    server = createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(join(root, SOCKET), resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the listener accepts a connect from outside bash (the control)", async () => {
    const before = accepted;
    await new Promise<void>((resolve, reject) => {
      const client = connect(join(root, SOCKET));
      client.on("connect", () => {
        client.destroy();
        resolve();
      });
      client.on("error", reject);
    });
    await waitFor(() => accepted > before);
    assert.ok(accepted > before, "the control connect was not accepted");
  });

  for (
    const command of [
      `cat ${SOCKET}`,
      `head -n 1 ${SOCKET}`,
      `tail -n 1 ${SOCKET}`,
      `wc -l ${SOCKET}`,
      `grep -n x ${SOCKET}`,
      `grep -rn x run`,
      `rg -n x ${SOCKET}`,
      `rg -n x run`,
      `sed -n 1p ${SOCKET}`,
      `ls -la run`,
    ]
  ) {
    const program = command.split(" ")[0];
    const missing = onPath(program) ? false : `${program} is not on PATH`;
    it(`is allowlisted and does not connect: ${command}`, { skip: missing }, async () => {
      assert.equal(
        classifyReadOnlyBash(command, root, root).allow,
        true,
        `expected the allowlist to admit: ${command}`,
      );
      const before = accepted;
      const ran = await runBash(command);
      // 126 and 127 are bash's "cannot execute" and "command not found": the
      // reader never ran.
      assert.ok(ran.code !== 126 && ran.code !== 127, `${command} did not run: ${ran.stderr}`);
      assert.notEqual(ran.code, null, `${command} was stopped: ${ran.stderr}`);
      // Give a connect that did happen time to reach the accept callback.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(accepted, before, `${command} connected to the socket`);
    });
  }
});

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
