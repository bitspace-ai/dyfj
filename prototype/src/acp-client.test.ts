import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type AcpExecutionProfile,
  type AcpProgressUpdate,
  type AcpRunInput,
  ActivePromptDeadline,
  assertProcessGroupSignaler,
  drainStream,
  guardedProtocolInput,
  processGroupSignalerEvalArgs,
  processGroupSignalerEvalSource,
  resolveProtocolMessageLimit,
  resolveSessionUpdateLimit,
  runAcpAgent,
  runSignalCommand,
  settleDrain,
} from "./acp-client";

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
    await new Deno.Command("/bin/kill", {
      args: ["-KILL", `-${childPid}`],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => undefined);
  }
  if (grandchildPid !== null) {
    await new Deno.Command("/bin/kill", {
      args: ["-KILL", String(grandchildPid)],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => undefined);
  }
}

async function expectContainedFailure(input: {
  prompt: string;
  phase: string;
  profile?: Partial<AcpExecutionProfile>;
  abortAfterDelta?: boolean;
  message?: string;
  confirmPermission?: AcpRunInput["confirmPermission"];
}): Promise<void> {
  const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
  const controller = new AbortController();
  try {
    await expect(runAcpAgent({
      profile: fixtureProfile(input.profile, pidFile),
      prompt: input.prompt,
      abortSignal: input.abortAfterDelta ? controller.signal : undefined,
      onTextDelta: input.abortAfterDelta ? () => controller.abort() : undefined,
      confirmPermission: input.confirmPermission,
    })).rejects.toMatchObject({
      name: "AcpRunnerError",
      phase: input.phase,
      ...(input.message === undefined ? {} : { message: input.message }),
    });
    const pid = Number(await Deno.readTextFile(pidFile));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(await processIsAlive(pid)).toBe(false);
  } finally {
    await Deno.remove(pidFile).catch(() => {});
  }
}

describe("ActivePromptDeadline", () => {
  test("excludes operator deliberation from active prompt execution", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(30, () => now);
    now = 10;
    deadline.pause();
    now = 1_000;
    expect(deadline.remainingMs).toBe(20);
    deadline.resume();
    now = 1_019;
    expect(deadline.remainingMs).toBe(1);
  });

  test("resumes with the remaining budget instead of resetting it", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(100, () => now);
    now = 40;
    deadline.pause();
    now = 1_000;
    deadline.resume();
    now = 1_060;
    expect(deadline.remainingMs).toBe(0);
  });

  test("does not pause after the prompt budget has expired", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(30, () => now);
    now = 31;
    deadline.pause();
    expect(deadline.isPaused).toBe(false);
    expect(deadline.remainingMs).toBe(0);
  });

  test("does not double-count an overlapping paused interval", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(100, () => now);
    now = 10;
    deadline.pause();
    now = 1_000;
    deadline.pause();
    now = 2_000;
    expect(deadline.remainingMs).toBe(90);
    deadline.resume();
    now = 2_090;
    expect(deadline.remainingMs).toBe(0);
  });
});

describe("runAcpAgent", () => {
  test("contains an asynchronous spawn failure without an unhandled error", async () => {
    await expect(runAcpAgent({
      profile: fixtureProfile({
        command: "/private/tmp/dyfj-acp-command-does-not-exist",
      }),
      prompt: "unused",
    })).rejects.toThrow("ACP child could not be started");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("rejects an unavailable process-group signaler before spawning", async () => {
    await expect(
      assertProcessGroupSignaler(
        "/private/tmp/dyfj-process-group-signaler-does-not-exist",
      ),
    ).rejects.toThrow("ACP process-group signaling is unavailable");
  });

  test("process-group signaler eval carries the run dir as argv", () => {
    const source = processGroupSignalerEvalSource();
    expect(source.includes(";void ")).toBe(false);
    expect(processGroupSignalerEvalArgs("/tmp/dyfj-run")).toEqual([
      "eval",
      source,
      "/tmp/dyfj-run",
    ]);
  });

  test("rejects a signaler that cannot address a negative process group", async () => {
    const signaler = await Deno.makeTempFile({ dir: Deno.cwd() });
    try {
      await Deno.writeTextFile(
        signaler,
        "#!/bin/sh\ncase \"$3\" in -*) exit 1;; *) exit 0;; esac\n",
      );
      await Deno.chmod(signaler, 0o700);
      await expect(assertProcessGroupSignaler(signaler)).rejects.toThrow(
        "ACP process-group signaling is unavailable",
      );
    } finally {
      await Deno.remove(signaler).catch(() => {});
    }
  });

  test("distinguishes an absent process group from a signaling failure", async () => {
    await expect(runSignalCommand(
      [
        "-c",
        'printf "%s\\n" "kill: -123: No such process" >&2; exit 1',
      ],
      500,
      "bash",
    )).resolves.toBe(false);
    await expect(runSignalCommand(
      [
        "-c",
        'printf "%s\\n" "kill: -123: Operation not permitted" >&2; exit 1',
      ],
      500,
      "bash",
    )).rejects.toMatchObject({
      phase: "terminate",
      message: expect.stringContaining("ACP process-group signaling failed"),
    });
  });

  test("bounds signaler diagnostics while reading them", async () => {
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
    expect(error).toMatchObject({ phase: "terminate" });
    expect(error.message.length).toBeLessThan(320);
  });

  test("cancels a stderr drain whose producer never closes", async () => {
    const stream = new Readable({ read() {} });
    const drain = drainStream(stream);
    await drain.cancel();
    await drain.done;
    expect(stream.destroyed).toBe(true);
    expect(() => stream.emit("error", new Error("late pipe error"))).not
      .toThrow();
  });

  test("cancels a stderr drain when cleanup reaches its deadline", async () => {
    const stream = new Readable({ read() {} });
    const drain = drainStream(stream);
    await settleDrain(drain, 1);
    expect(stream.destroyed).toBe(true);
    await drain.done;
  });

  test("bounds discarded stream bytes", async () => {
    const stream = Readable.from([
      new Uint8Array(8),
      new Uint8Array(8),
    ]);
    const drain = drainStream(stream, 10);
    await drain.done;
    expect(stream.destroyed).toBe(true);
  });

  test("negotiates v1, propagates an absolute workspace, and preserves update order", async () => {
    const deltas: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "ordered response",
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(result.protocolVersion).toBe(1);
    expect(result.externalSessionId).toBe("fixture-1");
    expect(result.agentName).toBe("dyfj-acp-fixture");
    expect(result.capabilities).toContain("sessionCapabilities.close");
    expect(result.capabilities).not.toContain("promptCapabilities");
    expect(deltas).toEqual(["first|", `cwd=${Deno.cwd()}|`, "last"]);
    expect(result.text).toBe(`first|cwd=${Deno.cwd()}|last`);
    expect(result.stopReason).toBe("stop");
    expect(result.acpStopReason).toBe("end_turn");
    expect(result.routeEvidence).toEqual({ source: "profile_declared" });
  });

  test("verifies ChatGPT authentication before creating the external session", async () => {
    const evidence: unknown[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile({
        requiredAuthentication: "chat-gpt",
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_AUTH_STATUS: "chat-gpt",
        },
      }),
      prompt: "ordered response",
      onRouteVerified: (routeEvidence) => {
        evidence.push(routeEvidence);
      },
    });
    expect(result.text).toContain("first|");
    expect(result.routeEvidence).toEqual({
      source: "profile_declared",
      authenticationType: "chat-gpt",
    });
    expect(evidence).toEqual([result.routeEvidence]);
  });

  test("returns an interrupted result when route persistence is cancelled", async () => {
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
    expect(result).toMatchObject({
      stopReason: "aborted",
    });
    expect(result).not.toHaveProperty("routeEvidence");
  });

  test("normalizes a non-Error route-verification rejection", async () => {
    await expect(runAcpAgent({
      profile: fixtureProfile({
        requiredAuthentication: "chat-gpt",
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_AUTH_STATUS: "chat-gpt",
        },
      }),
      prompt: "ordered response",
      onRouteVerified: () => Promise.reject("not an Error"),
    })).rejects.toMatchObject({
      phase: "authenticate",
      message: "ACP route verification could not be completed",
    });
  });

  test("classifies a route-verification timeout as authentication failure", async () => {
    await expect(runAcpAgent({
      profile: fixtureProfile({ sessionTimeoutMs: 10 }),
      prompt: "ordered response",
      onRouteVerified: () => new Promise<void>(() => {}),
    })).rejects.toMatchObject({ phase: "authenticate" });
  });

  test.each([
    ["unauthenticated", "AcpAuthenticationRequiredError"],
    ["api-key", "AcpAccessRouteMismatchError"],
    ["gateway", "AcpAccessRouteMismatchError"],
    ["malformed", "AcpAuthenticationEvidenceError"],
    ["missing", "AcpAuthenticationEvidenceError"],
  ])(
    "rejects %s authentication before route verification",
    async (status, name) => {
      let routeVerified = false;
      await expect(runAcpAgent({
        profile: fixtureProfile({
          requiredAuthentication: "chat-gpt",
          accessRoute: "subscription_oauth",
          costBasis: "subscription_quota",
          environment: {
            DENO_DIR: Deno.env.get("DENO_DIR") ??
              join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
            ACP_FIXTURE_AUTH_STATUS: status,
          },
        }),
        prompt: "ordered response",
        onRouteVerified: () => {
          routeVerified = true;
        },
      })).rejects.toMatchObject({ name, phase: "authenticate" });
      expect(routeVerified).toBe(false);
    },
  );

  test("observes cancellation while authentication status is stalled", async () => {
    const controller = new AbortController();
    const result = runAcpAgent({
      profile: fixtureProfile({
        requiredAuthentication: "chat-gpt",
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_AUTH_STATUS: "mute",
        },
      }),
      prompt: "unused",
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const aborted = await result;
    expect(aborted).toMatchObject({ stopReason: "aborted" });
    expect(aborted).not.toHaveProperty("routeEvidence");
  });

  test("signals a stubborn descendant that remains in the ACP process group", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const grandchildPidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Promise.all([
      Deno.remove(pidFile),
      Deno.remove(grandchildPidFile),
    ]);
    let verified = false;
    try {
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile, grandchildPidFile),
        prompt: "FIXTURE_STUBBORN_DESCENDANT ordered response",
      });
      expect(result.stopReason).toBe("stop");
      expect(result.text).not.toContain("fixture descendant spawn failed");
      const childPid = Number(await Deno.readTextFile(pidFile));
      const grandchildPid = Number(await Deno.readTextFile(grandchildPidFile));
      expect(await processIsAlive(childPid)).toBe(false);
      expect(await processIsAlive(grandchildPid)).toBe(false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(grandchildPidFile).catch(() => {});
    }
  });

  test("signals a stubborn descendant after the process-group leader exits", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const grandchildPidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Promise.all([
      Deno.remove(pidFile),
      Deno.remove(grandchildPidFile),
    ]);
    let verified = false;
    try {
      await expect(runAcpAgent({
        profile: fixtureProfile({}, pidFile, grandchildPidFile),
        prompt: "FIXTURE_STUBBORN_DESCENDANT FIXTURE_EARLY_EXIT",
      })).rejects.toMatchObject({ phase: "prompt" });
      const childPid = Number(await Deno.readTextFile(pidFile));
      const grandchildPid = Number(await Deno.readTextFile(grandchildPidFile));
      expect(await processIsAlive(childPid)).toBe(false);
      expect(await processIsAlive(grandchildPid)).toBe(false);
      verified = true;
    } finally {
      if (!verified) {
        await forceStopRecordedProcessTree(pidFile, grandchildPidFile);
      }
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(grandchildPidFile).catch(() => {});
    }
  });

  test("denies permission when no approval callback exists", async () => {
    const verdicts: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.decision);
      },
    });
    expect(result.text).toBe("denied");
    expect(verdicts).toEqual(["deny"]);
  });

  test("cancels an allow-only request when no approval callback exists", async () => {
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
    expect(result.text).toBe("denied");
    expect(verdicts).toEqual([{ decision: "cancel", source: "policy" }]);
  });

  test("selects the agent's allow option only after explicit approval", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      confirmPermission: async () => ({ optionId: "allow" }),
    });
    expect(result.text).toBe("approved");
  });

  test("returns each exact permission option identifier to the agent", async () => {
    const allowAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-always" }),
    });
    expect(allowAlways.text).toBe("allow-always");

    const allowOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "allow-once" }),
    });
    expect(allowOnce.text).toBe("allow-once");

    const rejectAlways = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-always" }),
    });
    expect(rejectAlways.text).toBe("reject-always");

    const rejectOnce = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => ({ optionId: "reject-once" }),
    });
    expect(rejectOnce.text).toBe("reject-once");

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
    expect(fallbackDenied.text).toBe("reject");
    expect(fallbackVerdicts).toEqual([{
      decision: "deny",
      source: "policy",
    }]);
  });

  test("bounds permission labels and substitutes an inert audit reference", async () => {
    let observedName = "";
    let observedTitle = "";
    const verdicts: string[] = [];
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_HOSTILE",
      confirmPermission: async (permission) => {
        expect(permission.toolCallId).toBe("acp-permission-1");
        observedName = permission.options[0]?.name ?? "";
        observedTitle = permission.toolCall.title;
        expect(permission.toolCall.name).toBe("write_file");
        expect(permission.toolCall.kind).toBe("edit");
        expect(permission.toolCall.inputSummary).toContain("fixture.txt");
        return { optionId: "allow" };
      },
      onPermissionVerdict: (verdict) => {
        verdicts.push(verdict.toolCallId);
      },
    });
    expect(result.text).toBe("approved");
    expect(observedName).not.toContain("\u001b");
    expect(observedTitle).not.toContain("\u001b");
    expect(new TextEncoder().encode(observedName).byteLength)
      .toBeLessThanOrEqual(
        128,
      );
    expect(verdicts).toEqual(["acp-permission-1"]);
  });

  test("does not approve after cancellation while confirmation is pending", async () => {
    const controller = new AbortController();
    const prompted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ optionId: string }>();
    const verdicts: string[] = [];
    let confirmationCancelled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
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
    await expect(resultPromise).resolves.toMatchObject({
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    expect(verdicts).toEqual(["cancel"]);
    expect(confirmationCancelled).toBe(true);
  });

  test("allows approval after a confirmation outlasts the active prompt budget", async () => {
    const prompted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ optionId: string }>();
    const verdicts: string[] = [];
    let confirmationCancelled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile({ promptTimeoutMs: 50 }),
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    decision.resolve({ optionId: "allow" });
    await expect(resultPromise).resolves.toMatchObject({
      text: "approved",
      stopReason: "stop",
    });
    expect(verdicts).toEqual(["approve"]);
    expect(confirmationCancelled).toBe(true);
  });

  test("keeps the deadline paused until overlapping confirmations settle and honors both verdicts", async () => {
    const prompted = Promise.withResolvers<void>();
    const firstDecision = Promise.withResolvers<{ optionId: string }>();
    const secondDecision = Promise.withResolvers<{ optionId: string }>();
    let confirmations = 0;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile({ promptTimeoutMs: 50 }),
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    firstDecision.resolve({ optionId: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    secondDecision.resolve({ optionId: "deny" });
    await expect(resultPromise).resolves.toMatchObject({
      text: "denied",
      stopReason: "stop",
    });
  });

  test("does not approve after cancellation while the verdict is being recorded", async () => {
    const controller = new AbortController();
    const verdictStarted = Promise.withResolvers<void>();
    const releaseVerdict = Promise.withResolvers<void>();
    const verdicts: string[] = [];
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
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
    await expect(resultPromise).resolves.toMatchObject({
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    expect(verdicts).toEqual(["approve", "cancel"]);
  });

  test("bounds permission verdict recording and closes its write signal", async () => {
    let writeCancelled = false;
    await expect(runAcpAgent({
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
    })).rejects.toMatchObject({ phase: "permission" });
    expect(writeCancelled).toBe(true);
  });

  test("revokes an in-flight approval and records cancellation before an early terminal", async () => {
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
    expect(settled).toBe(false);
    releaseCancellation.resolve();
    await expect(resultPromise).resolves.toMatchObject({ stopReason: "stop" });
    expect(verdicts).toEqual(["approve", "cancel"]);
  });

  test("joins cancellation from a pending confirmation before an early terminal", async () => {
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
        expect(verdict.decision).toBe("cancel");
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      },
    }).finally(() => {
      settled = true;
    });
    await confirmationStarted.promise;
    await cancellationStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseCancellation.resolve();
    await expect(resultPromise).resolves.toMatchObject({ stopReason: "stop" });
  });

  test("attributes an unavailable operator choice to policy cancellation", async () => {
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
    expect(result.text).toBe("denied");
    expect(verdicts).toEqual([{ decision: "cancel", source: "policy" }]);
  });

  test("rejects duplicate permission option identifiers", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_DUPLICATE_IDS",
      phase: "protocol",
    });
  });

  test("rejects an empty allow option identifier before confirmation", async () => {
    let confirmations = 0;
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_EMPTY_ALLOW_ID",
      phase: "protocol",
      confirmPermission: async () => {
        confirmations += 1;
        return { optionId: "" };
      },
    });
    expect(confirmations).toBe(0);
  });

  test("rejects a permission request that exceeds the bounded option list", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PERMISSION_OVER_LIMIT_DUPLICATE",
      phase: "protocol",
      message: "ACP agent exceeded the permission-option limit",
    });
  });

  test("does not confirm permission requested after the prompt is terminal", async () => {
    let confirmations = 0;
    const result = await runAcpAgent({
      profile: fixtureProfile({
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_MODE: "late_permission_during_close",
        },
      }),
      prompt: "FIXTURE_LATE_PERMISSION",
      confirmPermission: async () => {
        confirmations += 1;
        return { optionId: "allow" };
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(confirmations).toBe(0);
  });

  test("sends session cancellation and preserves delivered partial text", async () => {
    const controller = new AbortController();
    const resultPromise = runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_CANCEL",
      abortSignal: controller.signal,
      onTextDelta: () => controller.abort(),
    });
    await expect(resultPromise).resolves.toMatchObject({
      text: "partial\n",
      stopReason: "aborted",
    });
  });

  test("does not dispatch a prompt for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_CANCEL",
      abortSignal: controller.signal,
    })).resolves.toMatchObject({
      text: "",
      stopReason: "aborted",
    });
  });

  test("bounds initialization and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "initialize",
      profile: {
        initializeTimeoutMs: 500,
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_MODE: "initialize_mute",
        },
      },
    });
  });

  test("observes cancellation while initialization is stalled", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.remove(pidFile);
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const resultPromise = runAcpAgent({
        profile: fixtureProfile({
          initializeTimeoutMs: 2_000,
          environment: {
            DENO_DIR: Deno.env.get("DENO_DIR") ??
              join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
            ACP_FIXTURE_MODE: "initialize_mute",
          },
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
      await expect(resultPromise).resolves.toMatchObject({
        stopReason: "aborted",
        protocolVersion: undefined,
        externalSessionId: undefined,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(await processIsAlive(pid)).toBe(false);
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  test("bounds session creation and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "session",
      profile: {
        sessionTimeoutMs: 50,
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_MODE: "session_new_mute",
        },
      },
    });
  });

  test("rejects session updates sent before session creation", async () => {
    await expectContainedFailure({
      prompt: "unused",
      phase: "protocol",
      profile: {
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_MODE: "session_new_early_update",
        },
      },
    });
  });

  test("bounds session close and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "ordered response",
      phase: "terminate",
      profile: {
        terminationTimeoutMs: 50,
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          ACP_FIXTURE_MODE: "session_close_mute",
        },
      },
    });
  });

  test("bounds a mute prompt and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_MUTE",
      phase: "prompt",
      profile: { promptTimeoutMs: 50 },
    });
  });

  test("rejects an oversized prompt before spawning", async () => {
    const pidFile = await Deno.makeTempFile();
    await Deno.remove(pidFile);
    try {
      await expect(runAcpAgent({
        profile: fixtureProfile({}, pidFile),
        prompt: "x".repeat(60_001),
      })).rejects.toMatchObject({ phase: "prompt" });
      await expect(Deno.stat(pidFile)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  test("bounds an ignored cancellation and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_CANCEL_IGNORED",
      phase: "cancel",
      profile: { cancellationTimeoutMs: 50 },
      abortAfterDelta: true,
    });
  });

  test("contains an early child exit and reaps it", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_EARLY_EXIT",
      phase: "prompt",
    });
  });

  test("contains malformed updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_MALFORMED",
      phase: "protocol",
    });
  });

  test("rejects invalid UTF-8 protocol input and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_INVALID_UTF8",
      phase: "protocol",
    });
  });

  test("bounds valid streamed response content and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_OVERSIZED_RESPONSE",
      phase: "protocol",
    });
  });

  test("bounds session-update ingress and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_UPDATE_FLOOD",
      phase: "protocol",
      profile: { promptTimeoutMs: 10_000 },
    });
  });

  test("keeps the standard protocol-message ceiling for ordinary profiles", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LARGE_PROTOCOL_MESSAGE",
      phase: "protocol",
      message: "ACP agent exceeded the protocol-message limit",
    });
  });

  test("allows one bounded large message for a long-running profile", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile({ protocolMessagePolicy: "long_running" }),
      prompt: "FIXTURE_LARGE_PROTOCOL_MESSAGE",
    });
    expect(result.text).toBe("complete");
    expect(result.stopReason).toBe("stop");
  });

  test("bounds protocol messages for a long-running profile and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LONG_PROTOCOL_MESSAGE_FLOOD",
      phase: "protocol",
      profile: { protocolMessagePolicy: "long_running" },
      message: "ACP agent exceeded the protocol-message limit",
    });
  });

  test("resolves protocol-message ceilings from the execution profile", () => {
    expect(resolveProtocolMessageLimit(fixtureProfile())).toBe(393_216);
    expect(resolveProtocolMessageLimit(fixtureProfile({
      protocolMessagePolicy: "long_running",
    }))).toBe(1_048_576);
  });

  test("rejects an invalid protocol-message policy before spawning", async () => {
    await expect(runAcpAgent({
      profile: {
        ...fixtureProfile(),
        protocolMessagePolicy: "invalid",
      } as unknown as AcpExecutionProfile,
      prompt: "unused",
    })).rejects.toThrow("ACP profile has an invalid protocol-message policy");
  });

  test("allows a bounded long-running profile to complete after 1,024 updates", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile({ sessionUpdatePolicy: "long_running" }),
      prompt: "FIXTURE_LONG_UPDATE_STREAM",
    });
    expect(result.text).toBe("complete");
    expect(result.stopReason).toBe("stop");
  });

  test("bounds long-running session updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_LONG_UPDATE_FLOOD",
      phase: "protocol",
      profile: {
        sessionUpdatePolicy: "long_running",
        promptTimeoutMs: 30_000,
      },
    });
  });

  test("the ingress guard rejects update floods independently of the SDK consumer", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "" },
          },
        },
      })
    }\n`);
    let sent = 0;
    const guarded = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < 1_025) {
            sent += 1;
            controller.enqueue(payload);
          } else {
            controller.close();
          }
        },
      }),
      () => "fixture-1",
      () => {},
    );
    await expect(guarded.pipeTo(new WritableStream())).rejects.toThrow(
      "ACP agent exceeded the session-update limit",
    );
  });

  test("the ingress guard enforces the resolved long-running allowance", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "" },
          },
        },
      })
    }\n`);
    const profile = fixtureProfile({ sessionUpdatePolicy: "long_running" });
    const limit = resolveSessionUpdateLimit(profile);
    let sent = 0;
    const guarded = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent <= limit) {
            sent += 1;
            controller.enqueue(payload);
          } else {
            controller.close();
          }
        },
      }),
      () => "fixture-1",
      () => {},
      limit,
    );
    await expect(guarded.pipeTo(new WritableStream())).rejects.toThrow(
      "ACP agent exceeded the session-update limit",
    );
    expect(limit).toBe(8_192);
  });

  test("bounds cumulative protocol input at ingress", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_PROTOCOL_INPUT_FLOOD",
      phase: "protocol",
      profile: { promptTimeoutMs: 10_000 },
    });
  });

  test("accepts a valid protocol line fragmented into one-byte chunks", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "x".repeat(16_384) },
          },
        },
      })
    }\n`);
    const guarded = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      () => "fixture-1",
      () => {},
    );
    expect(new Uint8Array(await new Response(guarded).arrayBuffer())).toEqual(
      payload,
    );
  });

  test("rejects Windows absolute paths on non-Windows hosts", async () => {
    if (Deno.build.os === "windows") return;
    await expect(runAcpAgent({
      profile: fixtureProfile({
        command: "C:\\missing\\acp-agent.exe",
        workspace: "C:\\workspace",
      }),
      prompt: "unused",
    })).rejects.toThrow("ACP profile command must be absolute");
  });

  test.each(
    [
      ["FIXTURE_MAX_TOKENS", "length", "max_tokens"],
      ["FIXTURE_MAX_TURN_REQUESTS", "length", "max_turn_requests"],
      ["FIXTURE_REFUSAL", "error", "refusal"],
    ] as const,
  )(
    "normalizes %s while retaining the ACP stop reason",
    async (prompt, normalized, acpStopReason) => {
      const result = await runAcpAgent({
        profile: fixtureProfile(),
        prompt,
      });
      expect(result.stopReason).toBe(normalized);
      expect(result.acpStopReason).toBe(acpStopReason);
    },
  );

  test("rejects cross-session updates and reaps the child", async () => {
    await expectContainedFailure({
      prompt: "FIXTURE_CROSS_SESSION",
      phase: "protocol",
    });
  });

  test("does not inherit representative ambient values or secrets", async () => {
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
      expect(result.text).toBe(
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

  test("emits thought and tool progress without exposing thought text", async () => {
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
    expect(progressUpdates).toEqual([
      { kind: "thought" },
      {
        kind: "tool_call",
        title: "Inspecting codebase",
        name: "grep_search",
        status: "in_progress",
      },
    ]);
    expect(JSON.stringify(progressUpdates)).not.toContain("pondering problem");
    expect(deltas).toEqual(["solution found"]);
    expect(result.text).toBe("solution found");
    expect(result.text).not.toContain("pondering problem");
  });

  test("a never-settling progress observer cannot stall the turn", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.remove(pidFile);
    let verified = false;
    try {
      const result = await runAcpAgent({
        profile: fixtureProfile({}, pidFile),
        prompt: "FIXTURE_THOUGHT_AND_PROGRESS",
        onProgress: () => new Promise(() => {}),
      });
      expect(result.text).toBe("solution found");
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(Number.isInteger(pid)).toBe(true);
      expect(await processIsAlive(pid)).toBe(false);
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

  test("a rejecting progress observer cannot fail the turn", async () => {
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
    expect(calls).toBe(2);
    expect(result.text).toBe("solution found");
  });
});
