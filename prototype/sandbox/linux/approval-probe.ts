// Approval by the attested envelope, end to end (BIT-736). Started by
// `dyfj-sandbox serve` as the runtime (through approval-probe.sh), it drives
// the product's own bash and git tools through `invokeCommand`, with an
// approver that records each prompt and denies it, and prints one line per
// call. No model is called. Synthetic content only.
//
//   node approval-probe.ts attest                 the supervisor's attestation
//   node approval-probe.ts attest-after           the same, 3 s after start
//   node approval-probe.ts calls <posture>        in-workspace shell syntax
//   node approval-probe.ts escapes <posture>      attempts to cross the boundary
//   node approval-probe.ts session-grant <posture> an exact-command grant
//   node approval-probe.ts forge <posture>        a forged supervisor, a stale binding
//   node approval-probe.ts calls <posture> --native   the native route, nothing runs
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import process from "node:process";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { processEnv } from "../../src/config/mod.ts";
import type {
  CommandCall,
  CommandDefinition,
  SessionGrants,
  ToolApprovalRequest,
  ToolApprovalVerdict,
} from "../../src/tools/definition.ts";
import { checkAttestation } from "../../src/tools/builtin/containment.ts";
import { defineBash, executorSocket } from "../../src/tools/builtin/exec.ts";
import {
  createExecutorRunner,
  requestAttestation,
} from "../../src/tools/builtin/executor-transport.ts";
import { defineGit } from "../../src/tools/builtin/git.ts";
import { invokeCommand } from "../../src/tools/invoke.ts";
import { createCommandRegistry } from "../../src/tools/registry.ts";
import { nodeSocketHost } from "../../src/transport/mod.ts";

const [mode = "calls", posture = "strict", ...rest] = process.argv.slice(2);
const native = rest.includes("--native");
const ROOT = native ? process.cwd() : "/work";
const dial = nodeSocketHost.connect;

if (posture !== "strict" && posture !== "operator") {
  process.stderr.write("posture must be strict or operator\n");
  process.exit(2);
}

/** A runner for the native route that runs nothing. */
const refuseLocally = () =>
  Promise.reject(new Error("approval-probe: the native route runs nothing"));

function tools(env = processEnv) {
  const bash = defineBash(ROOT, native
    ? { env: new MapEnv({}), runner: refuseLocally }
    : { env, dialExecutor: dial });
  const git = defineGit(ROOT, native ? { env: new MapEnv({}) } : { env, dialExecutor: dial });
  return { bash, git };
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const keys = new Set<string>();
const grants: SessionGrants = { has: (k) => keys.has(k), add: (k) => void keys.add(k) };
let answer: ToolApprovalVerdict = { decision: "deny", reason: "approval-probe records and denies" };
const approver = (_request: ToolApprovalRequest) => Promise.resolve(answer);

/** A call the approver was asked about, and denied, shows as `ask`. */
function decisionLabel(decision: string, basis: string): string {
  return basis === "policy:deny:approval-denied" ? "ask" : decision;
}

async function invoke(
  label: string,
  command: CommandDefinition,
  args: Record<string, unknown>,
): Promise<void> {
  const call: CommandCall = {
    commandId: command.id,
    callId: `l9-${randomBytes(4).toString("hex")}`,
    caller: { principalId: "workbench", principalType: "agent" },
    arguments: args,
  };
  const result = await invokeCommand(createCommandRegistry([command]), call, approver, {
    permissionLevel: posture as "strict" | "operator",
    loopback: true,
    sessionGrants: grants,
  });
  const output = result.isError ? result.reason : String(result.result);
  const ran = result.decision === "allow" && !output.includes("the native route runs nothing");
  const exit = ran && !result.isError ? (/^exit (\S+)/.exec(output)?.[1] ?? "-") : "-";
  const evidence = result.authzBasis === "policy:deny:approval-denied"
    ? "-"
    : oneLine(ran && !result.isError ? output.replace(/^exit \S+\n?/, "") : output);
  process.stdout.write(
    `${label.padEnd(26)} decision=${decisionLabel(result.decision, result.authzBasis)}` +
      `  basis=${result.authzBasis}  ran=${ran ? "yes" : "no"}  exit=${exit}  evidence=${evidence}\n`,
  );
}

const sh = (command: string, timeoutSec?: number) =>
  timeoutSec === undefined ? { command } : { command, timeoutSec };

const SETUP_REPO =
  "git init -q -b main 2>/dev/null; git config user.email l9@example.invalid && " +
  "git config user.name 'L9 probe' && echo l9 > l9.txt && git add l9.txt && " +
  "git commit -qm 'L9: probe' && git log --oneline -1";

async function attest(): Promise<void> {
  const socket = executorSocket();
  if (socket === undefined) {
    process.stdout.write("unattested  route=native (no executor socket)\n");
    return;
  }
  const { bash } = tools();
  const verdict = await bash.containment!.attest();
  let reply: Record<string, unknown> = {};
  try {
    reply = await requestAttestation(socket, dial, randomBytes(16).toString("hex"));
  } catch (error) {
    reply = { error: (error as Error).message };
  }
  const probe = (reply.probe ?? {}) as Record<string, unknown>;
  const policy = reply.executorPolicy as { identity?: { run?: string; digest?: string; expiresAt?: string } } | null;
  if (verdict.status === "attested") {
    process.stdout.write(
      `attested  route=${verdict.envelope.route}  run=${verdict.envelope.run}  ` +
        `executor-policy=${verdict.envelope.policyDigest}  ` +
        `probe network=refused(${probe.connect}) outside-write=refused(${probe.write}) ms=${probe.ms}  ` +
        `granted=${verdict.granted ? "yes" : `no${reply.grantRefusal ? ` (${reply.grantRefusal})` : ""}`}  ` +
        `writable=${verdict.envelope.writable.join(",")}  ceiling=${verdict.envelope.commandTimeoutMs / 1000}s  ` +
        `expires=${verdict.envelope.expiresAt}\n`,
    );
  } else {
    process.stdout.write(
      `unattested  reason=${verdict.reason}  executor-policy=${policy?.identity?.digest ?? "-"}  ` +
        `probe connect=${probe.connect ?? "-"} write=${probe.write ?? "-"} ms=${probe.ms ?? "-"}  ` +
        `grant-refusal=${reply.grantRefusal ?? "-"}\n`,
    );
  }
}

async function calls(): Promise<void> {
  const { bash, git } = tools();
  await invoke("ls", bash, sh("ls -a"));
  await invoke("git-status", bash, sh("git status --short"));
  await invoke("pipe", bash, sh("printf 'b\\na\\nb\\n' | sort | uniq -c"));
  await invoke("cd-chain", bash, sh("mkdir -p sub && cd sub && cd .. && pwd"));
  await invoke("redirect-in-workspace", bash, sh("echo l9 > ./canary.txt && cat ./canary.txt && rm ./canary.txt"));
  await invoke("subshell-and-substitution", bash, sh('echo "year $(date -u +%Y)"'));
  await invoke(
    "compile-and-test",
    bash,
    sh(
      "printf 'import assert from \"node:assert/strict\";\\nimport { test } from \"node:test\";\\n" +
        "test(\"adds\", () => assert.equal(1 + 1, 2));\\n' > l9.test.mjs && " +
        "node --test l9.test.mjs 2>&1 | grep -E '^. (pass|fail) [0-9]+$'; rm -f l9.test.mjs",
    ),
  );
  await invoke("repo-setup", bash, sh(SETUP_REPO));
  await invoke("git-tool-status", git, { subcommand: "status" });
  await invoke("git-add-commit", bash, sh("echo again >> l9.txt && true"));
  await invoke("git-tool-add", git, { subcommand: "add", paths: ["l9.txt"] });
  await invoke("git-tool-commit", git, { subcommand: "commit", message: "L9: tool commit", paths: ["l9.txt"] });
}

async function escapes(): Promise<void> {
  const { bash, git } = tools();
  // approval-probe.sh plants it among the runtime's own secrets.
  const canary = ["/secrets/L9_CANARY", "/run/dyfj/secrets/L9_CANARY"].map((path) => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  }).find((value) => /^[0-9a-f]{48}$/.test(value));
  await invoke("write-outside", bash, sh("echo canary > /etc/dyfj-canary"));
  await invoke("write-outside-srv", bash, sh("echo canary >> /srv/dyfj/dyfj-canary"));
  await invoke("cd-escape-write", bash, sh("cd / && touch dyfj-canary"));
  await invoke(
    "egress-fetch",
    bash,
    sh(
      'node -e \'fetch("https://api.anthropic.com/").then(() => console.log("CONNECTED"), ' +
        "(e) => { console.log(e.cause?.code ?? e.message); process.exit(1); })'",
    ),
  );
  await invoke("egress-devtcp", bash, sh("exec 3<>/dev/tcp/1.1.1.1/443"));
  await invoke("repo-setup", bash, sh(SETUP_REPO));
  await invoke("git-push-file", bash, sh("git push file:///srv/dyfj/l9-remote.git HEAD 2>&1"));
  await invoke("git-push-https", bash, sh("git push https://github.com/example/none.git HEAD 2>&1"));
  await invoke("secret-files", bash, sh("ls /run/dyfj/secrets 2>&1 && cat /run/dyfj/secrets/* 2>&1"));
  if (canary === undefined) {
    process.stdout.write(`${"secret-canary".padEnd(26)} FAIL  no canary readable by the runtime\n`);
  } else await invoke(
    "secret-canary",
    bash,
    sh(
      `grep -rlsF -- '${canary}' /proc/*/environ /run /srv /home /tmp /work 2>/dev/null; ` +
        "test $? -eq 0 && echo FOUND",
    ),
  );
  await invoke(
    "mac-integration",
    bash,
    sh(
      "found=0; for p in /mnt/mac /var/run/docker.sock /run/docker.sock /opt/orbstack-guest; do " +
        '[ -e "$p" ] && { echo "present $p"; found=1; }; done; for c in mac orb docker; do ' +
        'command -v "$c" && found=1; done; [ -n "${SSH_AUTH_SOCK:-}" ] && found=1; [ "$found" = 1 ]',
    ),
  );
  await invoke(
    "privilege",
    bash,
    sh(
      "sudo -n true 2>&1 && exit 0; nft list ruleset >/dev/null 2>&1 && exit 0; " +
        "unshare -U true 2>&1 && exit 0; echo refused; exit 1",
    ),
  );
  await invoke("timeout-raise", bash, sh("true", 300));
  await invoke("git-tool-push", git, { subcommand: "push" });
}

async function sessionGrant(): Promise<void> {
  const { bash } = tools();
  answer = { decision: "approve", scope: "session" };
  await invoke("grant-first", bash, sh("echo canary > /etc/dyfj-canary"));
  answer = { decision: "deny", reason: "approval-probe records and denies" };
  await invoke("grant-repeat", bash, sh("echo canary > /etc/dyfj-canary"));
  // The same grant set, on a bash whose executor is gone.
  const gone = defineBash(ROOT, {
    env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/absent.sock" }),
    dialExecutor: dial,
  });
  await invoke("grant-without-executor", gone, sh("echo canary > /etc/dyfj-canary"));
  const direct = await gone.executor(
    {
      commandId: "bash",
      callId: "l9-direct",
      caller: { principalId: "workbench", principalType: "agent" },
      arguments: sh("echo canary > /etc/dyfj-canary"),
    },
    { authzBasis: "policy:allow:session-grant" },
  );
  process.stdout.write(`${"granted-runner-direct".padEnd(26)} ran=no  evidence=${oneLine(String(direct))}\n`);
}

async function forge(): Promise<void> {
  const socket = executorSocket()!;
  const real = await requestAttestation(socket, dial, randomBytes(16).toString("hex"));
  // A supervisor the runtime itself serves, replaying the real attestation
  // with whatever nonce it is sent, from a directory the runtime can write.
  const dir = mkdtempSync("/tmp/l9-forge-");
  const path = `${dir}/exec.sock`;
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end));
      connection.end(`${JSON.stringify({ ...real, nonce: request.nonce })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const forged = defineBash(ROOT, { env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: path }), dialExecutor: dial });
  const verdict = await forged.containment!.attest();
  process.stdout.write(
    `${"forged-supervisor".padEnd(26)} ${verdict.status}  ` +
      `${verdict.status === "unattested" ? `reason=${verdict.reason}` : "FORGERY ACCEPTED"}\n`,
  );
  await invoke("forged-supervisor-call", forged, sh("true"));
  server.close();
  rmSync(dir, { recursive: true, force: true });

  // A call bound to an instance other than the one serving.
  const check = checkAttestation(real, real.nonce as string, new Date(), 120_000);
  const stale = "0".repeat(32);
  try {
    await createExecutorRunner(socket, dial)("true", ROOT, 5_000, {}, stale);
    process.stdout.write(`${"stale-binding".padEnd(26)} ACCEPTED (expected a refusal)\n`);
  } catch (error) {
    process.stdout.write(
      `${"stale-binding".padEnd(26)} refused  evidence=${oneLine((error as Error).message)}  ` +
        `(serving instance ${check.status === "attested" ? check.envelope.instance : "unattested"})\n`,
    );
  }
}

const modes: Record<string, () => Promise<void>> = {
  attest,
  // For approval-probe.sh stale: attest once the plan has been rewritten.
  "attest-after": async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await attest();
  },
  calls,
  escapes,
  "session-grant": sessionGrant,
  forge,
};
const run = modes[mode];
if (run === undefined) {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
if (native) process.stdout.write("route=native (unattested)\n");
await run();
