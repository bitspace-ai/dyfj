// ACP client cases against the real fixture agent (scripts/acp-fixture-agent.ts)
// run as a child process in its own process group, plus the process-group
// signaler itself. Child processes, `/bin/kill`, `bash` and environment reads
// put these in the integration tier; the pure client cases live in
// acp-client.test.ts.
import {
  assert,
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import {
  type AcpExecutionProfile,
  type AcpProgressUpdate,
  type AcpRunInput,
  assertProcessGroupSignaler,
  runAcpAgent,
  runSignalCommand,
  startAcpSession,
} from "./acp-client.ts";

function fixtureProfile(
  overrides: Partial<AcpExecutionProfile> = {},
  pidFile?: string,
  grandchildPidFile?: string,
): AcpExecutionProfile {
  const home = Deno.env.get("HOME") ?? "/tmp";
  return {
    slug: "fixture",
    command: Deno.execPath(),
    args: [
      "run",
      "--cached-only",
      "--allow-env=ACP_FIXTURE_ALLOWED,ACP_FIXTURE_MODE,ACP_FIXTURE_AUTH_STATUS,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK",
      ...(grandchildPidFile === undefined
        ? ["--allow-run=/bin/kill"]
        : ["--allow-run=bash,/bin/kill"]),
      ...(pidFile === undefined ? [] : [`--allow-write=${pidFile}`]),
      ...(grandchildPidFile === undefined ? [] : [
        `--allow-read=${grandchildPidFile}`,
        `--allow-write=${grandchildPidFile}`,
      ]),
      join(import.meta.dirname!, "../scripts/acp-fixture-agent.ts"),
      ...(pidFile === undefined ? [] : [`--pid-file=${pidFile}`]),
      ...(grandchildPidFile === undefined
        ? []
        : [`--grandchild-pid-file=${grandchildPidFile}`]),
    ],
    environment: {
      DENO_DIR: Deno.env.get("DENO_DIR") ?? join(home, ".cache/deno"),
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      ACP_FIXTURE_ALLOWED: "yes",
    },
    workspace: Deno.cwd(),
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
    DENO_DIR: Deno.env.get("DENO_DIR") ??
      join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
    ...extra,
  };
}

/** A temp file outside the checkout; removed by the caller. */
function tempPath(): Promise<string> {
  return Deno.makeTempFile({ prefix: "dyfj-acp-client-" });
}

async function processIsAlive(pid: number): Promise<boolean> {
  const status = await new Deno.Command("bash", {
    args: [
      "-c",
      'state=$(ps -o stat= -p "$1" 2>/dev/null) || exit 1; set -- $state; case "${1:-}" in ""|Z*) exit 1;; esac',
      "bash",
      String(pid),
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  return status.success;
}

async function forceStopRecordedProcessTree(
  pidFile: string,
  grandchildPidFile: string,
): Promise<void> {
  const readPid = async (path: string): Promise<number | null> => {
    const pid = Number(await Deno.readTextFile(path).catch(() => ""));
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

/** Asserts `promise` rejects with an error carrying each expected field. */
async function assertRejectsWithFields(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<Error> {
  const error = await assertRejects(() => promise);
  for (const [key, value] of Object.entries(expected)) {
    assertEquals(
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
      }),
      {
        name: "AcpRunnerError",
        phase: input.phase,
        ...(input.message === undefined ? {} : { message: input.message }),
      },
    );
    const pid = Number(await Deno.readTextFile(pidFile));
    assertStrictEquals(Number.isSafeInteger(pid) && pid > 0, true);
    assertStrictEquals(await processIsAlive(pid), false);
  } finally {
    await Deno.remove(pidFile).catch(() => {});
  }
}

describe("runAcpAgent", () => {
  it("contains an asynchronous spawn failure without an unhandled error", async () => {
    await assertRejects(
      () =>
        runAcpAgent({
          profile: fixtureProfile({
            command: "/private/tmp/dyfj-acp-command-does-not-exist",
          }),
          prompt: "unused",
        }),
      Error,
      "ACP child could not be started",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects an unavailable process-group signaler before spawning", async () => {
    await assertRejects(
      () =>
        assertProcessGroupSignaler(
          "/private/tmp/dyfj-process-group-signaler-does-not-exist",
        ),
      Error,
      "ACP process-group signaling is unavailable",
    );
  });

  it("rejects a signaler that cannot address a negative process group", async () => {
    const signaler = await tempPath();
    try {
      await Deno.writeTextFile(
        signaler,
        '#!/bin/sh\ncase "$3" in -*) exit 1;; *) exit 0;; esac\n',
      );
      await Deno.chmod(signaler, 0o700);
      await assertRejects(
        () => assertProcessGroupSignaler(signaler),
        Error,
        "ACP process-group signaling is unavailable",
      );
    } finally {
      await Deno.remove(signaler).catch(() => {});
    }
  });

  it("distinguishes an absent process group from a signaling failure", async () => {
    assertStrictEquals(
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
    assertStringIncludes(error.message, "ACP process-group signaling failed");
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
    assertObjectMatch(
      error as unknown as Record<PropertyKey, unknown>,
      { phase: "terminate" },
    );
    assert(error.message.length < 320);
  });

  it("negotiates v1, propagates an absolute workspace, and preserves update order", async () => {
    const deltas: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "ordered response",
      onTextDelta: (delta) => deltas.push(delta),
    });

    assertStrictEquals(result.protocolVersion, 1);
    assertStrictEquals(result.externalSessionId, "fixture-1");
    assertStrictEquals(result.agentName, "dyfj-acp-fixture");
    assert(result.capabilities.includes("sessionCapabilities.close"));
    assertFalse(result.capabilities.includes("promptCapabilities"));
    assertEquals(deltas, ["first|", `cwd=${Deno.cwd()}|`, "last"]);
    assertStrictEquals(result.text, `first|cwd=${Deno.cwd()}|last`);
    assertStrictEquals(result.stopReason, "stop");
    assertStrictEquals(result.acpStopReason, "end_turn");
    assertEquals(result.routeEvidence, { source: "profile_declared" });
  });

  it("retains optional ACP prompt usage and the latest context/cost snapshot", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_USAGE",
    });
    assertEquals(result.usage, {
      total: 1_250,
      input: 1_000,
      output: 200,
      reasoning: 50,
      cacheRead: 400,
    });
    assertEquals(result.usageSnapshot, {
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
    assertStringIncludes(result.text, "first|");
    assertEquals(result.routeEvidence, {
      source: "profile_declared",
      authenticationType: "chat-gpt",
    });
    assertEquals(evidence, [result.routeEvidence]);
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
    assertObjectMatch(result, {
      stopReason: "aborted",
    });
    assertFalse("routeEvidence" in result);
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
      assertStrictEquals(routeVerified, false);
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
      assertObjectMatch(aborted, { stopReason: "aborted" });
      assertFalse("routeEvidence" in aborted);
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
        Deno.remove(pidFile),
        Deno.remove(grandchildPidFile),
      ]);
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile, grandchildPidFile),
        prompt: "FIXTURE_STUBBORN_DESCENDANT ordered response",
      });
      assertStrictEquals(result.stopReason, "stop");
      assertFalse(result.text.includes("fixture descendant spawn failed"));
      const childPid = Number(await Deno.readTextFile(pidFile));
      const grandchildPid = Number(await Deno.readTextFile(grandchildPidFile));
      assertStrictEquals(await processIsAlive(childPid), false);
      assertStrictEquals(await processIsAlive(grandchildPid), false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(grandchildPidFile).catch(() => {});
    }
  });

  it("signals a stubborn descendant after the process-group leader exits", async () => {
    const pidFile = await tempPath();
    const grandchildPidFile = await tempPath();
    let verified = false;
    try {
      await Promise.all([
        Deno.remove(pidFile),
        Deno.remove(grandchildPidFile),
      ]);
      await assertRejectsWithFields(
        runAcpAgent({
          profile: fixtureProfile({}, pidFile, grandchildPidFile),
          prompt: "FIXTURE_STUBBORN_DESCENDANT FIXTURE_EARLY_EXIT",
        }),
        { phase: "prompt" },
      );
      const childPid = Number(await Deno.readTextFile(pidFile));
      const grandchildPid = Number(await Deno.readTextFile(grandchildPidFile));
      assertStrictEquals(await processIsAlive(childPid), false);
      assertStrictEquals(await processIsAlive(grandchildPid), false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(grandchildPidFile).catch(() => {});
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
    assertStrictEquals(result.text, "denied");
    assertEquals(verdicts, ["deny"]);
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
    assertStrictEquals(result.text, "denied");
    assertEquals(verdicts, [{ decision: "cancel", source: "policy" }]);
  });

  it("selects the agent's allow option only after explicit approval", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      confirmPermission: async () => ({ optionId: "allow" }),
    });
    assertStrictEquals(result.text, "approved");
  });

  it("returns each exact permission option identifier to the agent", async () => {
    const allowAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-always" }),
    });
    assertStrictEquals(allowAlways.text, "allow-always");

    const allowOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-once" }),
    });
    assertStrictEquals(allowOnce.text, "allow-once");

    const rejectAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-always" }),
    });
    assertStrictEquals(rejectAlways.text, "reject-always");

    const rejectOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-once" }),
    });
    assertStrictEquals(rejectOnce.text, "reject-once");

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
    assertStrictEquals(fallbackDenied.text, "reject");
    assertEquals(fallbackVerdicts, [{
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
        assertStrictEquals(permission.toolCallId, "acp-permission-1");
        observedName = permission.options[0]?.name ?? "";
        observedTitle = permission.toolCall.title;
        assertStrictEquals(permission.toolCall.name, "write_file");
        assertStrictEquals(permission.toolCall.kind, "edit");
        assertStringIncludes(permission.toolCall.inputSummary, "fixture.txt");
        return { optionId: "allow" };
      },
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.toolCallId);
      },
    });
    assertStrictEquals(result.text, "approved");
    assertFalse(observedName.includes("\u001b"));
    assertFalse(observedTitle.includes("\u001b"));
    assert(new TextEncoder().encode(observedName).byteLength <= 128);
    assertEquals(verdicts, ["acp-permission-1"]);
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
    assertObjectMatch(await resultPromise, {
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    assertEquals(verdicts, ["cancel"]);
    assertStrictEquals(confirmationCancelled, true);
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
    assertObjectMatch(await resultPromise, {
      text: "approved",
      stopReason: "stop",
    });
    assertEquals(verdicts, ["approve"]);
    assertStrictEquals(confirmationCancelled, true);
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
    assertObjectMatch(await resultPromise, {
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
    assertObjectMatch(await resultPromise, {
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    assertEquals(verdicts, ["approve", "cancel"]);
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
    assertStrictEquals(writeCancelled, true);
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
    assertStrictEquals(settled, false);
    releaseCancellation.resolve();
    assertObjectMatch(await resultPromise, { stopReason: "stop" });
    assertEquals(verdicts, ["approve", "cancel"]);
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
        assertStrictEquals(verdict.decision, "cancel");
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      },
    }).finally(() => {
      settled = true;
    });
    await confirmationStarted.promise;
    await cancellationStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertStrictEquals(settled, false);
    releaseCancellation.resolve();
    assertObjectMatch(await resultPromise, { stopReason: "stop" });
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
    assertStrictEquals(result.text, "denied");
    assertEquals(verdicts, [{ decision: "cancel", source: "policy" }]);
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
    assertStrictEquals(confirmations, 0);
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
    assertStrictEquals(result.stopReason, "stop");
    assertStrictEquals(confirmations, 0);
  });

  it("sends session cancellation and preserves delivered partial text", async () => {
    const controller = new AbortController();
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_CANCEL",
      abortSignal: controller.signal,
      onTextDelta: () => controller.abort(),
    });
    assertObjectMatch(await resultPromise, {
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
      await Deno.remove(pidFile);
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
          await Deno.stat(pidFile);
          break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          if (Date.now() >= deadline) throw new Error("fixture did not start");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      controller.abort();
      assertObjectMatch(await resultPromise, {
        stopReason: "aborted",
        protocolVersion: undefined,
        externalSessionId: undefined,
      });
      assert(Date.now() - startedAt < 1_000);
      const pid = Number(await Deno.readTextFile(pidFile));
      assertStrictEquals(await processIsAlive(pid), false);
    } finally {
      await Deno.remove(pidFile).catch(() => {});
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
      await Deno.remove(pidFile);
      await assertRejectsWithFields(
        runAcpAgent({
          profile: fixtureProfile({}, pidFile),
          prompt: "x".repeat(60_001),
        }),
        { phase: "prompt" },
      );
      await assertRejects(() => Deno.stat(pidFile), Deno.errors.NotFound);
    } finally {
      await Deno.remove(pidFile).catch(() => {});
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
    assertStrictEquals(result.text, "complete");
    assertStrictEquals(result.stopReason, "stop");
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
    assertStrictEquals(result.text, "complete");
    assertStrictEquals(result.stopReason, "stop");
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
      assertStrictEquals(result.stopReason, normalized);
      assertStrictEquals(result.acpStopReason, acpStopReason);
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
      names.map((name) => [name, Deno.env.get(name)]),
    );
    for (const name of names) Deno.env.set(name, "must-not-cross");
    try {
      const result = await runAcpAgent({
        profile: fixtureProfile(),
        prompt: "FIXTURE_ENV",
      });
      assertStrictEquals(
        result.text,
        "allowed=yes;ambient=missing;ANTHROPIC_API_KEY=missing;" +
          "DOLT_PASSWORD=missing;DYFJ_MEMORY_MCP_TOKEN=missing;" +
          "SSH_AUTH_SOCK=missing",
      );
    } finally {
      for (const [name, value] of originals) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
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
    assertEquals(progressUpdates, [
      { kind: "thought" },
      {
        kind: "tool_call",
        title: "Inspecting codebase",
        name: "grep_search",
        status: "in_progress",
      },
    ]);
    assertFalse(JSON.stringify(progressUpdates).includes("pondering problem"));
    assertEquals(deltas, ["solution found"]);
    assertStrictEquals(result.text, "solution found");
    assertFalse(result.text.includes("pondering problem"));
  });

  it("merges bounded ACP tool updates into terminal evidence", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_TOOL_HISTORY",
    });
    assertStrictEquals(result.text, "recorded");
    assertEquals(result.toolEvidence, {
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
      assertStrictEquals(result.text, "recorded");
      assertEquals(result.toolEvidence, {
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
    assertStrictEquals(result.stopReason, "aborted");
    assertObjectMatch(result.toolEvidence!, {
      status: "unavailable",
      calls: [],
    });
  });

  it("a never-settling progress observer cannot stall the turn", async () => {
    const pidFile = await tempPath();
    let verified = false;
    try {
      await Deno.remove(pidFile);
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile),
        prompt: "FIXTURE_THOUGHT_AND_PROGRESS",
        onProgress: () => new Promise(() => {}),
      });
      assertStrictEquals(result.text, "solution found");
      const pid = Number(await Deno.readTextFile(pidFile));
      assertStrictEquals(Number.isInteger(pid), true);
      assertStrictEquals(await processIsAlive(pid), false);
      verified = true;
    } finally {
      if (!verified) {
        try {
          const pid = Number(await Deno.readTextFile(pidFile));
          if (Number.isInteger(pid)) {
            await new Deno.Command("/bin/kill", {
              args: ["-KILL", String(pid)],
              stdout: "null",
              stderr: "null",
            }).output();
          }
        } catch {
          // Best-effort cleanup if the assertion failed before reap.
        }
      }
      await Deno.remove(pidFile).catch(() => {});
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
    assertStrictEquals(calls, 2);
    assertStrictEquals(result.text, "solution found");
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
        assertStrictEquals(first.text, "x".repeat(50_000));
        assertStrictEquals(first.stopReason, "stop");
        const second = await session.prompt({
          prompt: "FIXTURE_NEAR_LIMIT_RESPONSE",
        });
        assertStrictEquals(second.text, "x".repeat(50_000));
        assertStrictEquals(second.stopReason, "stop");
        assertStrictEquals(session.isAlive, true);
      } finally {
        await session.close();
        const pid = Number(await Deno.readTextFile(pidFile));
        assertStrictEquals(await processIsAlive(pid), false);
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });
});
