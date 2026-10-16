// ACP client cases against the real fixture agent (scripts/acp-fixture-agent.ts)
// run as a child process in its own process group, plus the process-group
// signaler itself. Child processes, `/bin/kill`, `bash` and environment reads
// put these in the integration tier; the pure client cases live in
// acp-client.test.ts.
import { captureRejection } from "../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import {
  type AcpExecutionProfile,
  type AcpProgressUpdate,
  type AcpRunInput,
  assertProcessGroupSignaler,
  runAcpAgent,
  runSignalCommand,
  startAcpSession,
} from "./acp-client.ts";
import { fixtureAgentCommand } from "./acp-fixture-command.ts";
import { composeRuntimePolicy, type RuntimePolicy } from "./config/mod.ts";

/** The base run policy plus `commands`, for tests that start other binaries. */
function allowing(...commands: string[]): RuntimePolicy {
  const base = composeRuntimePolicy();
  return { ...base, run: [...base.run, ...commands] };
}

function fixtureProfile(
  overrides: Partial<AcpExecutionProfile> = {},
  pidFile?: string,
  grandchildPidFile?: string,
): AcpExecutionProfile {
  const home = process.env.HOME ?? "/tmp";
  return {
    slug: "fixture",
    ...fixtureAgentCommand({
      scriptArgs: [
        ...(pidFile === undefined ? [] : [`--pid-file=${pidFile}`]),
        ...(grandchildPidFile === undefined
          ? []
          : [`--grandchild-pid-file=${grandchildPidFile}`]),
      ],
    }),
    environment: {
      DENO_DIR: process.env.DENO_DIR ?? join(home, ".cache/deno"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ACP_FIXTURE_ALLOWED: "yes",
    },
    workspace: process.cwd(),
    transport: "local_stdio",
    accessRoute: "local_sidecar",
    costBasis: "local_free",
    initializeTimeoutMs: 2_000,
    sessionTimeoutMs: 2_000,
    promptTimeoutMs: 2_000,
    cancellationTimeoutMs: 500,
    terminationTimeoutMs: 500,
    ...overrides,
  };
}

/** The fixture's environment with one extra variable set. */
function fixtureEnvironment(
  extra: Record<string, string>,
): Record<string, string> {
  return {
    DENO_DIR: process.env.DENO_DIR ??
      join(process.env.HOME ?? "/tmp", ".cache/deno"),
    ...extra,
  };
}

/**
 * A new empty file outside the checkout, alone in its own temp directory;
 * the caller removes it with `removeTempPath`.
 */
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-acp-client-"));
  const path = join(dir, "file");
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return path;
}

/** Removes a `tempPath` file and the directory made for it. */
function removeTempPath(path: string): Promise<void> {
  return rm(dirname(path), { recursive: true, force: true });
}

async function processIsAlive(pid: number): Promise<boolean> {
  const code = await runQuietly("bash", [
    "-c",
    'state=$(ps -o stat= -p "$1" 2>/dev/null) || exit 1; set -- $state; case "${1:-}" in ""|Z*) exit 1;; esac',
    "bash",
    String(pid),
  ]);
  return code === 0;
}

// Runs a helper command to its exit and returns its exit code (null when a
// signal ended it). Cwd and stdin are inherited, stdout and stderr are
// discarded. Only a helper that cannot start fails: spawn reports that as an
// `error` event. `close` fires once the child has exited and its streams have
// closed, so no helper outlives the call. Given no env, spawn copies the whole
// parent env, which needs an unscoped env grant; the integration lane grants
// env by name. PATH is the one variable these helpers resolve anything
// through (bash and the ps it runs), so it is the one forwarded.
function runQuietly(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const path = process.env.PATH;
    const child = spawn(file, args, {
      env: path === undefined ? {} : { PATH: path },
      stdio: ["inherit", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

async function forceStopRecordedProcessTree(
  pidFile: string,
  grandchildPidFile: string,
): Promise<void> {
  const readPid = async (path: string): Promise<number | null> => {
    const pid = Number(await readFile(path, "utf8").catch(() => ""));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  };
  const childPid = await readPid(pidFile);
  const grandchildPid = await readPid(grandchildPidFile);
  if (childPid !== null) {
    await runSignalCommand(["-KILL", "--", `-${childPid}`], 500).catch(
      () => undefined,
    );
  }
  if (grandchildPid !== null) {
    await runSignalCommand(["-KILL", "--", String(grandchildPid)], 500).catch(
      () => undefined,
    );
  }
}

/** The pid a process records in `path`, once it has written one. */
async function waitForRecordedPid(
  path: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid was recorded in ${path} within ${timeoutMs} ms`);
}

/** Whether `pid` has exited (or is a zombie) within `timeoutMs`. */
async function exitsWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processIsAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await processIsAlive(pid));
}

/** Asserts `promise` rejects with an error carrying each expected field. */
async function assertRejectsWithFields(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<Error> {
  const error = await captureRejection(() => promise);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(
      (error as Record<string, unknown>)[key],
      value,
      `error.${key}`,
    );
  }
  return error as Error;
}

async function expectContainedFailure(input: {
  prompt: string;
  phase: string;
  profile?: Partial<AcpExecutionProfile>;
  abortAfterDelta?: boolean;
  message?: string;
  confirmPermission?: AcpRunInput["confirmPermission"];
  holdStdoutOpen?: boolean;
}): Promise<void> {
  const pidFile = await tempPath();
  try {
    const controller = new AbortController();
    const profile = fixtureProfile(input.profile, pidFile);
    await assertRejectsWithFields(
      runAcpAgent({
        // A backgrounded descendant inherits the agent's stdout, so the stream
        // stays open after the agent itself exits.
        profile: input.holdStdoutOpen
          ? {
            ...profile,
            command: "/bin/bash",
            args: [
              "-c",
              'sleep 0.5 & exec "$0" "$@"',
              profile.command,
              ...profile.args,
            ],
          }
          : profile,
        prompt: input.prompt,
        abortSignal: input.abortAfterDelta ? controller.signal : undefined,
        onTextDelta: input.abortAfterDelta
          ? () => controller.abort()
          : undefined,
        confirmPermission: input.confirmPermission,
        runPolicy: allowing("/bin/bash"),
      }),
      {
        name: "AcpRunnerError",
        phase: input.phase,
        ...(input.message === undefined ? {} : { message: input.message }),
      },
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.strictEqual(Number.isSafeInteger(pid) && pid > 0, true);
    assert.strictEqual(await processIsAlive(pid), false);
  } finally {
    await removeTempPath(pidFile).catch(() => {});
  }
}

describe("runAcpAgent", () => {
  it("contains an asynchronous spawn failure without an unhandled error", async () => {
    await assert.rejects(
      () =>
        runAcpAgent({
          profile: fixtureProfile({
            command: "/private/tmp/dyfj-acp-command-does-not-exist",
          }),
          prompt: "unused",
          runPolicy: allowing("/private/tmp/dyfj-acp-command-does-not-exist"),
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("ACP child could not be started"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects an unavailable process-group signaler before spawning", async () => {
    await assert.rejects(
      () =>
        assertProcessGroupSignaler(
          "/private/tmp/dyfj-process-group-signaler-does-not-exist",
          undefined,
          undefined,
          allowing("/private/tmp/dyfj-process-group-signaler-does-not-exist"),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("ACP process-group signaling is unavailable"),
    );
  });

  it("maps a probe child that cannot start to the fixed diagnostic", async () => {
    // A NUL in the command makes the spawn throw synchronously.
    const error = await assertRejectsWithFields(
      assertProcessGroupSignaler(
        "/bin/kill",
        500,
        ["/bin/sle\0ep", "30"],
        allowing("/bin/sle\0ep"),
      ),
      { phase: "spawn" },
    );
    assert.strictEqual(
      error.message,
      "ACP process-group signaling is unavailable on this platform",
    );
  });

  it("rejects a signaler that cannot address a negative process group", async () => {
    const signaler = await tempPath();
    try {
      await writeFile(
        signaler,
        '#!/bin/sh\ncase "$3" in -*) exit 1;; *) exit 0;; esac\n',
      );
      await chmod(signaler, 0o700);
      await assert.rejects(
        () =>
          assertProcessGroupSignaler(
            signaler,
            undefined,
            undefined,
            allowing(signaler),
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("ACP process-group signaling is unavailable"),
      );
    } finally {
      await removeTempPath(signaler).catch(() => {});
    }
  });

  it("maps a signaler that cannot start to the fixed diagnostic", async () => {
    const error = await assertRejectsWithFields(
      runSignalCommand(
        ["-0", "--", "-1"],
        500,
        "/private/tmp/dyfj-process-group-signaler-does-not-exist",
        allowing("/private/tmp/dyfj-process-group-signaler-does-not-exist"),
      ),
      { phase: "terminate" },
    );
    assert.strictEqual(error.message, "ACP process-group signaling failed");
  });

  it("distinguishes an absent process group from a signaling failure", async () => {
    assert.strictEqual(
      await runSignalCommand(
        [
          "-c",
          'printf "%s\\n" "kill: -123: No such process" >&2; exit 1',
        ],
        500,
        "bash",
      ),
      false,
    );
    const error = await assertRejectsWithFields(
      runSignalCommand(
        [
          "-c",
          'printf "%s\\n" "kill: -123: Operation not permitted" >&2; exit 1',
        ],
        500,
        "bash",
      ),
      { phase: "terminate" },
    );
    assert.ok(
      error.message.includes("ACP process-group signaling failed"),
      `expected error.message to include "ACP process-group signaling failed"`,
    );
  });

  it("bounds signaler diagnostics while reading them", async () => {
    const failure = runSignalCommand(
      [
        "-c",
        "i=0; while [ $i -lt 10000 ]; do printf x >&2; i=$((i+1)); done; exit 1",
      ],
      500,
      "bash",
    );
    const error = await failure.then(
      () => {
        throw new Error("expected signaler failure");
      },
      (value) => value as Error,
    );
    // partialDeepStrictEqual never matches an Error against a plain object,
    // so the one field is compared directly.
    assert.strictEqual(
      (error as unknown as Record<PropertyKey, unknown>).phase,
      "terminate",
    );
    assert.ok(error.message.length < 320);
  });

  it("negotiates v1, propagates an absolute workspace, and preserves update order", async () => {
    const deltas: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "ordered response",
      onTextDelta: (delta) => deltas.push(delta),
    });

    assert.strictEqual(result.protocolVersion, 1);
    assert.strictEqual(result.externalSessionId, "fixture-1");
    assert.strictEqual(result.agentName, "dyfj-acp-fixture");
    assert.ok(result.capabilities.includes("sessionCapabilities.close"));
    assert.ok(!result.capabilities.includes("promptCapabilities"));
    assert.deepStrictEqual(deltas, ["first|", `cwd=${process.cwd()}|`, "last"]);
    assert.strictEqual(result.text, `first|cwd=${process.cwd()}|last`);
    assert.strictEqual(result.stopReason, "stop");
    assert.strictEqual(result.acpStopReason, "end_turn");
    assert.deepStrictEqual(result.routeEvidence, {
      source: "profile_declared",
    });
  });

  it("retains optional ACP prompt usage and the latest context/cost snapshot", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_USAGE",
    });
    assert.deepStrictEqual(result.usage, {
      total: 1_250,
      input: 1_000,
      output: 200,
      reasoning: 50,
      cacheRead: 400,
    });
    assert.deepStrictEqual(result.usageSnapshot, {
      used: 1_250,
      size: 8_192,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("verifies ChatGPT authentication before creating the external session", async () => {
    const evidence: unknown[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile({
        requiredAuthentication: "chat-gpt",
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        environment: fixtureEnvironment({
          ACP_FIXTURE_AUTH_STATUS: "chat-gpt",
        }),
      }),
      prompt: "ordered response",
      onRouteVerified: (routeEvidence) => {
        evidence.push(routeEvidence);
      },
    });
    assert.ok(
      result.text.includes("first|"),
      `expected result.text to include "first|"`,
    );
    assert.deepStrictEqual(result.routeEvidence, {
      source: "profile_declared",
      authenticationType: "chat-gpt",
    });
    assert.deepStrictEqual(evidence, [result.routeEvidence]);
  });

  it("returns an interrupted result when route persistence is cancelled", async () => {
    const controller = new AbortController();
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "ordered response",
      abortSignal: controller.signal,
      onRouteVerified: (_evidence, signal) => {
        controller.abort();
        if (signal.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
      },
    });
    assert.partialDeepStrictEqual(result, {
      stopReason: "aborted",
    });
    assert.ok(!("routeEvidence" in result));
  });

  it("normalizes a non-Error route-verification rejection", async () => {
    await assertRejectsWithFields(
      runAcpAgent({
        profile: fixtureProfile({
          requiredAuthentication: "chat-gpt",
          environment: fixtureEnvironment({
            ACP_FIXTURE_AUTH_STATUS: "chat-gpt",
          }),
        }),
        prompt: "ordered response",
        onRouteVerified: () => Promise.reject("not an Error"),
      }),
      {
        phase: "authenticate",
        message: "ACP route verification could not be completed",
      },
    );
  });

  it("classifies a route-verification timeout as authentication failure", async () => {
    await assertRejectsWithFields(
      runAcpAgent({
        profile: fixtureProfile({ sessionTimeoutMs: 10 }),
        prompt: "ordered response",
        onRouteVerified: () => new Promise<void>(() => {}),
      }),
      { phase: "authenticate" },
    );
  });

  for (
    const [status, name] of [
      ["unauthenticated", "AcpAuthenticationRequiredError"],
      ["api-key", "AcpAccessRouteMismatchError"],
      ["gateway", "AcpAccessRouteMismatchError"],
      ["malformed", "AcpAuthenticationEvidenceError"],
      ["missing", "AcpAuthenticationEvidenceError"],
    ]
  ) {
    it(`rejects ${status} authentication before route verification`, async () => {
      let routeVerified = false;
      await assertRejectsWithFields(
        runAcpAgent({
          profile: fixtureProfile({
            requiredAuthentication: "chat-gpt",
            accessRoute: "subscription_oauth",
            costBasis: "subscription_quota",
            environment: fixtureEnvironment({
              ACP_FIXTURE_AUTH_STATUS: status,
            }),
          }),
          prompt: "ordered response",
          onRouteVerified: () => {
            routeVerified = true;
          },
        }),
        { name, phase: "authenticate" },
      );
      assert.strictEqual(routeVerified, false);
    });
  }

  it("observes cancellation while authentication status is stalled", async () => {
    const controller = new AbortController();
    const result = runAcpAgent({
      profile: fixtureProfile({
        requiredAuthentication: "chat-gpt",
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        environment: fixtureEnvironment({ ACP_FIXTURE_AUTH_STATUS: "mute" }),
      }),
      prompt: "unused",
      abortSignal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const aborted = await result;
      assert.partialDeepStrictEqual(aborted, { stopReason: "aborted" });
      assert.ok(!("routeEvidence" in aborted));
    } finally {
      clearTimeout(timer);
    }
  });

  it("signals a stubborn descendant that remains in the ACP process group", async () => {
    const pidFile = await tempPath();
    const grandchildPidFile = await tempPath();
    let verified = false;
    try {
      await Promise.all([
        unlink(pidFile),
        unlink(grandchildPidFile),
      ]);
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile, grandchildPidFile),
        prompt: "FIXTURE_STUBBORN_DESCENDANT ordered response",
      });
      assert.strictEqual(result.stopReason, "stop");
      assert.ok(!result.text.includes("fixture descendant spawn failed"));
      const childPid = Number(await readFile(pidFile, "utf8"));
      const grandchildPid = Number(await readFile(grandchildPidFile, "utf8"));
      assert.strictEqual(await processIsAlive(childPid), false);
      assert.strictEqual(await processIsAlive(grandchildPid), false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(grandchildPidFile).catch(() => {});
    }
  });

  it("signals a stubborn descendant after the process-group leader exits", async () => {
    const pidFile = await tempPath();
    const grandchildPidFile = await tempPath();
    let verified = false;
    try {
      await Promise.all([
        unlink(pidFile),
        unlink(grandchildPidFile),
      ]);
      await assertRejectsWithFields(
        runAcpAgent({
          profile: fixtureProfile({}, pidFile, grandchildPidFile),
          prompt: "FIXTURE_STUBBORN_DESCENDANT FIXTURE_EARLY_EXIT",
        }),
        { phase: "prompt" },
      );
      const childPid = Number(await readFile(pidFile, "utf8"));
      const grandchildPid = Number(await readFile(grandchildPidFile, "utf8"));
      assert.strictEqual(await processIsAlive(childPid), false);
      assert.strictEqual(await processIsAlive(grandchildPid), false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(grandchildPidFile).catch(() => {});
    }
  });

  it("denies permission when no approval callback exists", async () => {
    const verdicts: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.decision);
      },
    });
    assert.strictEqual(result.text, "denied");
    assert.deepStrictEqual(verdicts, ["deny"]);
  });

  it("cancels an allow-only request when no approval callback exists", async () => {
    const verdicts: Array<{ decision: string; source: string }> = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_ALLOW_ONLY",
      onPermissionVerdict: (verdict) => {
        verdicts.push({
          decision: verdict.decision,
          source: verdict.source,
        });
      },
    });
    assert.strictEqual(result.text, "denied");
    assert.deepStrictEqual(verdicts, [{
      decision: "cancel",
      source: "policy",
    }]);
  });

  it("selects the agent's allow option only after explicit approval", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      confirmPermission: async () => ({ optionId: "allow" }),
    });
    assert.strictEqual(result.text, "approved");
  });

  it("returns each exact permission option identifier to the agent", async () => {
    const allowAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-always" }),
    });
    assert.strictEqual(allowAlways.text, "allow-always");

    const allowOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-once" }),
    });
    assert.strictEqual(allowOnce.text, "allow-once");

    const rejectAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-always" }),
    });
    assert.strictEqual(rejectAlways.text, "reject-always");

    const rejectOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-once" }),
    });
    assert.strictEqual(rejectOnce.text, "reject-once");

    const fallbackVerdicts: Array<{ decision: string; source: string }> = [];
    const fallbackDenied = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_REJECT_ONLY",
      confirmPermission: async () => ({ optionId: "unavailable" }),
      onPermissionVerdict: (verdict) => {
        fallbackVerdicts.push({
          decision: verdict.decision,
          source: verdict.source,
        });
      },
    });
    assert.strictEqual(fallbackDenied.text, "reject");
    assert.deepStrictEqual(fallbackVerdicts, [{
      decision: "deny",
      source: "policy",
    }]);
  });

  it("bounds permission labels and substitutes an inert audit reference", async () => {
    let observedName = "";
    let observedTitle = "";
    const verdicts: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_HOSTILE",
      confirmPermission: async (permission) => {
        assert.strictEqual(permission.toolCallId, "acp-permission-1");
        observedName = permission.options[0]?.name ?? "";
        observedTitle = permission.toolCall.title;
        assert.strictEqual(permission.toolCall.name, "write_file");
        assert.strictEqual(permission.toolCall.kind, "edit");
        assert.ok(
          permission.toolCall.inputSummary.includes("fixture.txt"),
          `expected permission.toolCall.inputSummary to include "fixture.txt"`,
        );
        return { optionId: "allow" };
      },
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.toolCallId);
      },
    });
    assert.strictEqual(result.text, "approved");
    assert.ok(!observedName.includes("\u001b"));
    assert.ok(!observedTitle.includes("\u001b"));
    assert.ok(new TextEncoder().encode(observedName).byteLength <= 128);
    assert.deepStrictEqual(verdicts, ["acp-permission-1"]);
  });

  it("does not approve after cancellation while confirmation is pending", async () => {
    const controller = new AbortController();
    const prompted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ optionId: string }>();
    const verdicts: string[] = [];
    let confirmationCancelled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_EXPECT_CANCEL",
      abortSignal: controller.signal,
      confirmPermission: (_permission, signal) => {
        prompted.resolve();
        signal.addEventListener("abort", () => {
          confirmationCancelled = true;
        }, { once: true });
        return decision.promise;
      },
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.decision);
      },
    });
    await prompted.promise;
    controller.abort();
    decision.resolve({ optionId: "allow" });
    assert.partialDeepStrictEqual(await resultPromise, {
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    assert.deepStrictEqual(verdicts, ["cancel"]);
    assert.strictEqual(confirmationCancelled, true);
  });

  it("allows approval after a confirmation outlasts the active prompt budget", async () => {
    // Exact deadline arithmetic is covered in acp-client.test.ts; leave slack
    // for real IPC.
    const promptTimeoutMs = 1_000;
    const prompted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ optionId: string }>();
    const verdicts: string[] = [];
    let confirmationCancelled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile({ promptTimeoutMs }),
      prompt: "FIXTURE_PERMISSION",
      confirmPermission: (_permission, signal) => {
        prompted.resolve();
        signal.addEventListener("abort", () => {
          confirmationCancelled = true;
        }, { once: true });
        return decision.promise;
      },
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.decision);
      },
    });
    await prompted.promise;
    await new Promise((resolve) => setTimeout(resolve, promptTimeoutMs + 100));
    decision.resolve({ optionId: "allow" });
    assert.partialDeepStrictEqual(await resultPromise, {
      text: "approved",
      stopReason: "stop",
    });
    assert.deepStrictEqual(verdicts, ["approve"]);
    assert.strictEqual(confirmationCancelled, true);
  });

  it("keeps the deadline paused until overlapping confirmations settle and honors both verdicts", async () => {
    const promptTimeoutMs = 1_000;
    const prompted = Promise.withResolvers<void>();
    const firstDecision = Promise.withResolvers<{ optionId: string }>();
    const secondDecision = Promise.withResolvers<{ optionId: string }>();
    let confirmations = 0;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile({ promptTimeoutMs }),
      prompt: "FIXTURE_PERMISSION_OVERLAP",
      confirmPermission: () => {
        confirmations += 1;
        if (confirmations === 2) prompted.resolve();
        return confirmations === 1
          ? firstDecision.promise
          : secondDecision.promise;
      },
    });
    await prompted.promise;
    await new Promise((resolve) => setTimeout(resolve, promptTimeoutMs + 100));
    firstDecision.resolve({ optionId: "allow" });
    await new Promise((resolve) => setTimeout(resolve, promptTimeoutMs + 100));
    secondDecision.resolve({ optionId: "deny" });
    assert.partialDeepStrictEqual(await resultPromise, {
      text: "denied",
      stopReason: "stop",
    });
  });

  it("does not approve after cancellation while the verdict is being recorded", async () => {
    const controller = new AbortController();
    const verdictStarted = Promise.withResolvers<void>();
    const releaseVerdict = Promise.withResolvers<void>();
    const verdicts: string[] = [];
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_EXPECT_CANCEL",
      abortSignal: controller.signal,
      confirmPermission: async () => ({ optionId: "allow" }),
      onPermissionVerdict: async (verdict) => {
        verdicts.push(verdict.decision);
        if (verdict.decision === "approve") {
          verdictStarted.resolve();
          await releaseVerdict.promise;
        }
      },
    });
    await verdictStarted.promise;
    controller.abort();
    releaseVerdict.resolve();
    assert.partialDeepStrictEqual(await resultPromise, {
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    assert.deepStrictEqual(verdicts, ["approve", "cancel"]);
  });

  it("bounds permission verdict recording and closes its write signal", async () => {
    let writeCancelled = false;
    await assertRejectsWithFields(
      runAcpAgent({
        profile: fixtureProfile({ permissionVerdictTimeoutMs: 50 }),
        prompt: "FIXTURE_PERMISSION",
        confirmPermission: async () => ({ optionId: "allow" }),
        onPermissionVerdict: (_verdict, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              writeCancelled = true;
              reject(new DOMException("cancelled", "AbortError"));
            }, { once: true });
          }),
      }),
      { phase: "permission" },
    );
    assert.strictEqual(writeCancelled, true);
  });

  it("revokes an in-flight approval and records cancellation before an early terminal", async () => {
    const controller = new AbortController();
    const approvalStarted = Promise.withResolvers<void>();
    const cancellationStarted = Promise.withResolvers<void>();
    const releaseCancellation = Promise.withResolvers<void>();
    const verdicts: string[] = [];
    let settled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_EARLY_TERMINAL",
      abortSignal: controller.signal,
      confirmPermission: async () => ({ optionId: "allow" }),
      onPermissionVerdict: async (verdict, signal) => {
        verdicts.push(verdict.decision);
        if (verdict.decision === "approve") {
          approvalStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("closed", "AbortError")),
              { once: true },
            );
          });
        }
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      },
    }).finally(() => {
      settled = true;
    });
    await approvalStarted.promise;
    await cancellationStarted.promise;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(settled, false);
    releaseCancellation.resolve();
    assert.partialDeepStrictEqual(await resultPromise, { stopReason: "stop" });
    assert.deepStrictEqual(verdicts, ["approve", "cancel"]);
  });

  it("joins cancellation from a pending confirmation before an early terminal", async () => {
    const confirmationStarted = Promise.withResolvers<void>();
    const cancellationStarted = Promise.withResolvers<void>();
    const releaseCancellation = Promise.withResolvers<void>();
    let settled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_EARLY_TERMINAL",
      confirmPermission: (_permission, signal) => {
        confirmationStarted.resolve();
        return new Promise<{ optionId: string }>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("closed", "AbortError")),
            { once: true },
          );
        });
      },
      onPermissionVerdict: async (verdict) => {
        assert.strictEqual(verdict.decision, "cancel");
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      },
    }).finally(() => {
      settled = true;
    });
    await confirmationStarted.promise;
    await cancellationStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(settled, false);
    releaseCancellation.resolve();
    assert.partialDeepStrictEqual(await resultPromise, { stopReason: "stop" });
  });

  it("attributes an unavailable operator choice to policy cancellation", async () => {
    const verdicts: Array<{ decision: string; source: string }> = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_ALLOW_ONLY",
      confirmPermission: async () => ({ optionId: "unavailable" }),
      onPermissionVerdict: (verdict) => {
        verdicts.push({
          decision: verdict.decision,
          source: verdict.source,
        });
      },
    });
    assert.strictEqual(result.text, "denied");
    assert.deepStrictEqual(verdicts, [{
      decision: "cancel",
      source: "policy",
    }]);
  });

  it("rejects duplicate permission option identifiers", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_DUPLICATE_IDS",
      phase: "protocol",
    });
  });

  it("rejects an empty allow option identifier before confirmation", async () => {
    let confirmations = 0;
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_EMPTY_ALLOW_ID",
      phase: "protocol",
      confirmPermission: async () => {
        confirmations += 1;
        return { optionId: "" };
      },
    });
    assert.strictEqual(confirmations, 0);
  });

  it("rejects a permission request that exceeds the bounded option list", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_OVER_LIMIT_DUPLICATE",
      phase: "protocol",
      message: "ACP agent exceeded the permission-option limit",
    });
  });

  it("does not confirm permission requested after the prompt is terminal", async () => {
    let confirmations = 0;
    const result = await runAcpAgent({
      profile: fixtureProfile({
        environment: fixtureEnvironment({
          ACP_FIXTURE_MODE: "late_permission_during_close",
        }),
      }),
      prompt: "FIXTURE_LATE_PERMISSION",
      confirmPermission: async () => {
        confirmations += 1;
        return { optionId: "allow" };
      },
    });
    assert.strictEqual(result.stopReason, "stop");
    assert.strictEqual(confirmations, 0);
  });

  it("sends session cancellation and preserves delivered partial text", async () => {
    const controller = new AbortController();
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_CANCEL",
      abortSignal: controller.signal,
      onTextDelta: () => controller.abort(),
    });
    assert.partialDeepStrictEqual(await resultPromise, {
      text: "partial\n",
      stopReason: "aborted",
    });
  });

  it("bounds initialization and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "initialize",
      profile: {
        initializeTimeoutMs: 500,
        environment: fixtureEnvironment({
          ACP_FIXTURE_MODE: "initialize_mute",
        }),
      },
    });
  });

  it("observes cancellation while initialization is stalled", async () => {
    const pidFile = await tempPath();
    try {
      await unlink(pidFile);
      const controller = new AbortController();
      const startedAt = Date.now();
      const resultPromise = runAcpAgent({
        profile: fixtureProfile({
          initializeTimeoutMs: 2_000,
          environment: fixtureEnvironment({
            ACP_FIXTURE_MODE: "initialize_mute",
          }),
        }, pidFile),
        prompt: "unused",
        abortSignal: controller.signal,
      });
      const deadline = Date.now() + 1_000;
      while (true) {
        try {
          await stat(pidFile);
          break;
        } catch (error) {
          if (
            !(error instanceof Error &&
              (error as { code?: unknown }).code === "ENOENT")
          ) throw error;
          if (Date.now() >= deadline) throw new Error("fixture did not start");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      controller.abort();
      assert.partialDeepStrictEqual(await resultPromise, {
        stopReason: "aborted",
        protocolVersion: undefined,
        externalSessionId: undefined,
      });
      assert.ok(Date.now() - startedAt < 1_000);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.strictEqual(await processIsAlive(pid), false);
    } finally {
      await removeTempPath(pidFile).catch(() => {});
    }
  });

  it("bounds session creation and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "session",
      profile: {
        sessionTimeoutMs: 50,
        environment: fixtureEnvironment({
          ACP_FIXTURE_MODE: "session_new_mute",
        }),
      },
    });
  });

  it("rejects session updates sent before session creation", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "protocol",
      profile: {
        environment: fixtureEnvironment({
          ACP_FIXTURE_MODE: "session_new_early_update",
        }),
      },
    });
  });

  it("bounds session close and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "ordered response",
      phase: "terminate",
      profile: {
        terminationTimeoutMs: 50,
        environment: fixtureEnvironment({
          ACP_FIXTURE_MODE: "session_close_mute",
        }),
      },
    });
  });

  it("bounds a mute prompt and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_MUTE",
      phase: "prompt",
      profile: { promptTimeoutMs: 50 },
    });
  });

  it("rejects an oversized prompt before spawning", async () => {
    const pidFile = await tempPath();
    try {
      await unlink(pidFile);
      await assertRejectsWithFields(
        runAcpAgent({
          profile: fixtureProfile({}, pidFile),
          prompt: "x".repeat(60_001),
        }),
        { phase: "prompt" },
      );
      await assert.rejects(
        () => stat(pidFile),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === "ENOENT",
      );
    } finally {
      await removeTempPath(pidFile).catch(() => {});
    }
  });

  it("bounds an ignored cancellation and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_CANCEL_IGNORED",
      phase: "cancel",
      profile: { cancellationTimeoutMs: 50 },
      abortAfterDelta: true,
    });
  });

  it("contains an early child exit and reaps it", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_EARLY_EXIT",
      phase: "prompt",
    });
  });

  it("contains an early child exit while its stdout is still held open", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_EARLY_EXIT",
      phase: "prompt",
      holdStdoutOpen: true,
    });
    // Outlive the descendant so any late stream teardown lands in this test.
    await new Promise((resolve) => setTimeout(resolve, 800));
  });

  it("contains malformed updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_MALFORMED",
      phase: "protocol",
    });
  });

  it("rejects invalid UTF-8 protocol input and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_INVALID_UTF8",
      phase: "protocol",
    });
  });

  it("bounds valid streamed response content and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_OVERSIZED_RESPONSE",
      phase: "protocol",
    });
  });

  it("bounds session-update ingress and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_UPDATE_FLOOD",
      phase: "protocol",
      profile: { promptTimeoutMs: 10_000 },
    });
  });

  it("keeps the standard protocol-message ceiling for ordinary profiles", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LARGE_PROTOCOL_MESSAGE",
      phase: "protocol",
      message: "ACP agent exceeded the protocol-message limit",
    });
  });

  it("allows one bounded large message for a long-running profile", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile({ protocolMessagePolicy: "long_running" }),
      prompt: "FIXTURE_LARGE_PROTOCOL_MESSAGE",
    });
    assert.strictEqual(result.text, "complete");
    assert.strictEqual(result.stopReason, "stop");
  });

  it("bounds protocol messages for a long-running profile and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LONG_PROTOCOL_MESSAGE_FLOOD",
      phase: "protocol",
      profile: { protocolMessagePolicy: "long_running" },
      message: "ACP agent exceeded the protocol-message limit",
    });
  });

  it("allows a bounded long-running profile to complete after 1,024 updates", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile({ sessionUpdatePolicy: "long_running" }),
      prompt: "FIXTURE_LONG_UPDATE_STREAM",
    });
    assert.strictEqual(result.text, "complete");
    assert.strictEqual(result.stopReason, "stop");
  });

  it("bounds long-running session updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LONG_UPDATE_FLOOD",
      phase: "protocol",
      profile: {
        sessionUpdatePolicy: "long_running",
        promptTimeoutMs: 30_000,
      },
    });
  });

  it("bounds cumulative protocol input at ingress", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PROTOCOL_INPUT_FLOOD",
      phase: "protocol",
      profile: { promptTimeoutMs: 10_000 },
    });
  });

  for (
    const [prompt, normalized, acpStopReason] of [
      ["FIXTURE_MAX_TOKENS", "length", "max_tokens"],
      ["FIXTURE_MAX_TURN_REQUESTS", "length", "max_turn_requests"],
      ["FIXTURE_REFUSAL", "error", "refusal"],
    ] as const
  ) {
    it(`normalizes ${prompt} while retaining the ACP stop reason`, async () => {
      const result = await runAcpAgent({
        profile: fixtureProfile(),
        prompt,
      });
      assert.strictEqual(result.stopReason, normalized);
      assert.strictEqual(result.acpStopReason, acpStopReason);
    });
  }

  it("rejects cross-session updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_CROSS_SESSION",
      phase: "protocol",
    });
  });

  it("does not inherit representative ambient values or secrets", async () => {
    const names = [
      "ACP_FIXTURE_AMBIENT_VALUE",
      "ANTHROPIC_API_KEY",
      "DOLT_PASSWORD",
      "DYFJ_MEMORY_MCP_TOKEN",
      "SSH_AUTH_SOCK",
    ];
    const originals = new Map(
      names.map((
        name,
      ) => [
        name,
        Object.hasOwn(process.env, name) ? process.env[name] : undefined,
      ]),
    );
    for (const name of names) process.env[name] = "must-not-cross";
    try {
      const result = await runAcpAgent({
        profile: fixtureProfile(),
        prompt: "FIXTURE_ENV",
      });
      assert.strictEqual(
        result.text,
        "allowed=yes;ambient=missing;ANTHROPIC_API_KEY=missing;" +
          "DOLT_PASSWORD=missing;DYFJ_MEMORY_MCP_TOKEN=missing;" +
          "SSH_AUTH_SOCK=missing",
      );
    } finally {
      for (const [name, value] of originals) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("emits thought and tool progress without exposing thought text", async () => {
    const progressUpdates: AcpProgressUpdate[] = [];
    const deltas: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_THOUGHT_AND_PROGRESS",
      onTextDelta: (delta) => deltas.push(delta),
      onProgress: (update) => {
        progressUpdates.push(update);
      },
    });
    assert.deepStrictEqual(progressUpdates, [
      { kind: "thought" },
      {
        kind: "tool_call",
        title: "Inspecting codebase",
        name: "grep_search",
        status: "in_progress",
      },
    ]);
    assert.ok(!JSON.stringify(progressUpdates).includes("pondering problem"));
    assert.deepStrictEqual(deltas, ["solution found"]);
    assert.strictEqual(result.text, "solution found");
    assert.ok(!result.text.includes("pondering problem"));
  });

  it("merges bounded ACP tool updates into terminal evidence", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_TOOL_HISTORY",
    });
    assert.strictEqual(result.text, "recorded");
    assert.deepStrictEqual(result.toolEvidence, {
      status: "complete",
      observedCalls: 1,
      calls: [{
        toolCallId: "fixture-history-call",
        title: "Read fixture history",
        kind: "read",
        status: "completed",
        rawInputJson: '{"path":"fixture-history.txt"}',
        rawOutputJson: '{"text":"codename=zephyr-quill-7"}',
      }],
    });
  });

  for (
    const [prompt, observedCalls] of [
      ["FIXTURE_TOOL_HISTORY_DUPLICATE_ID", 1],
      ["FIXTURE_TOOL_HISTORY_UNKNOWN_UPDATE", 0],
      ["FIXTURE_TOOL_HISTORY_NONTERMINAL", 1],
    ] as const
  ) {
    it(`marks malformed or incomplete ACP tool history unavailable: ${prompt}`, async () => {
      const result = await runAcpAgent({
        profile: fixtureProfile(),
        prompt,
      });
      assert.strictEqual(result.text, "recorded");
      assert.deepStrictEqual(result.toolEvidence, {
        status: "unavailable",
        observedCalls,
        calls: [],
      });
    });
  }

  it("marks interrupted ACP tool history unavailable", async () => {
    const controller = new AbortController();
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_TOOL_HISTORY_INTERRUPTED",
      abortSignal: controller.signal,
      onProgress: (update) => {
        if (update.kind === "tool_call") controller.abort();
      },
    });
    assert.strictEqual(result.stopReason, "aborted");
    assert.partialDeepStrictEqual(result.toolEvidence!, {
      status: "unavailable",
      calls: [],
    });
  });

  it("a never-settling progress observer cannot stall the turn", async () => {
    const pidFile = await tempPath();
    let verified = false;
    try {
      await unlink(pidFile);
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile),
        prompt: "FIXTURE_THOUGHT_AND_PROGRESS",
        onProgress: () => new Promise(() => {}),
      });
      assert.strictEqual(result.text, "solution found");
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.strictEqual(Number.isInteger(pid), true);
      assert.strictEqual(await processIsAlive(pid), false);
      verified = true;
    } finally {
      if (!verified) {
        try {
          const pid = Number(await readFile(pidFile, "utf8"));
          if (Number.isInteger(pid)) {
            await runQuietly("/bin/kill", ["-KILL", String(pid)]);
          }
        } catch {
          // Best-effort cleanup if the assertion failed before reap.
        }
      }
      await removeTempPath(pidFile).catch(() => {});
    }
  });

  it("a rejecting progress observer cannot fail the turn", async () => {
    let calls = 0;
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_THOUGHT_AND_PROGRESS",
      onProgress: () => {
        calls += 1;
        if (calls === 1) throw new Error("progress observer failed");
        return Promise.reject(new Error("async progress observer failed"));
      },
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.text, "solution found");
  });
});

/**
 * Starts the fixture agent through `agentCommand(pidFile)` under a bash parent
 * with job control, beside a second member of its process group, then
 * SIGKILLs the parent. Both must be gone within the watchdog's interval.
 */
async function assertGroupReapedOnParentDeath(
  agentCommand: (pidFile: string) => { command: string; args: string[] },
): Promise<void> {
  const pidFile = await tempPath();
  const memberPidFile = await tempPath();
  let agentPid: number | undefined;
  let memberPid: number | undefined;
  let verified = false;
  try {
    await Promise.all([unlink(pidFile), unlink(memberPidFile)]);
    const agent = agentCommand(pidFile);
    // With job control on, bash gives the background pipeline a process
    // group of its own, led by its first process: the agent. `sleep` is the
    // group's second member, and only a signal to the group ends it before
    // its 300 s are up. SIGKILLing bash orphans both.
    const home = process.env.HOME ?? "/tmp";
    const parent = spawn("bash", [
      "-c",
      'set -m; "$@" < /dev/null | /bin/sleep 300 & echo "$!" > "$0"; wait',
      memberPidFile,
      agent.command,
      ...agent.args,
    ], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: "ignore",
    });
    const parentClosed = new Promise<void>((resolve) => {
      parent.once("error", () => resolve());
      parent.once("close", () => resolve());
    });
    try {
      agentPid = await waitForRecordedPid(pidFile);
      memberPid = await waitForRecordedPid(memberPidFile);
      assert.strictEqual(await processIsAlive(memberPid), true);
    } finally {
      parent.kill("SIGKILL");
      await parentClosed;
    }
    assert.strictEqual(
      await exitsWithin(agentPid, 5_000),
      true,
      "the fixture agent outlived its parent",
    );
    assert.strictEqual(
      await exitsWithin(memberPid, 5_000),
      true,
      "the second member of the agent's process group outlived its parent",
    );
    verified = true;
  } finally {
    if (!verified) {
      if (agentPid !== undefined) {
        await runSignalCommand(["-KILL", "--", `-${agentPid}`], 500).catch(
          () => undefined,
        );
      }
      if (memberPid !== undefined) {
        await runSignalCommand(["-KILL", "--", String(memberPid)], 500)
          .catch(() => undefined);
      }
    }
    await removeTempPath(pidFile).catch(() => {});
    await removeTempPath(memberPidFile).catch(() => {});
  }
}

describe("the fixture agent's parent-death watchdog", () => {
  it("kills its own process group once its parent dies", async () => {
    await assertGroupReapedOnParentDeath((pidFile) =>
      fixtureAgentCommand({ scriptArgs: [`--pid-file=${pidFile}`] })
    );
  });

  it("reaps its group without starting a process", async () => {
    // Node's permission model with no child-process grant: a reap that
    // spawned `/bin/kill` would be refused, and the group would survive.
    await assertGroupReapedOnParentDeath((pidFile) => {
      const agent = fixtureAgentCommand({
        scriptArgs: [`--pid-file=${pidFile}`],
      });
      return {
        command: agent.command,
        args: [
          "--permission",
          "--allow-fs-read=*",
          `--allow-fs-write=${pidFile}`,
          ...agent.args,
        ],
      };
    });
  });
});

describe("startAcpSession", () => {
  it("resets ingress caps at each prompt on a warm session", async () => {
    const pidFile = await tempPath();
    try {
      const session = await startAcpSession({
        profile: fixtureProfile({}, pidFile),
      });
      try {
        const first = await session.prompt({
          prompt: "FIXTURE_NEAR_LIMIT_RESPONSE",
        });
        assert.strictEqual(first.text, "x".repeat(50_000));
        assert.strictEqual(first.stopReason, "stop");
        const second = await session.prompt({
          prompt: "FIXTURE_NEAR_LIMIT_RESPONSE",
        });
        assert.strictEqual(second.text, "x".repeat(50_000));
        assert.strictEqual(second.stopReason, "stop");
        assert.strictEqual(session.isAlive, true);
      } finally {
        await session.close();
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.strictEqual(await processIsAlive(pid), false);
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
    }
  });
});
