import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type AcpExecutionProfile,
  assertProcessGroupSignaler,
  drainStream,
  guardedProtocolInput,
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
      ...(grandchildPidFile === undefined ? [] : ["--allow-run=bash"]),
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
}): Promise<void> {
  const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
  const controller = new AbortController();
  try {
    await expect(runAcpAgent({
      profile: fixtureProfile(input.profile, pidFile),
      prompt: input.prompt,
      abortSignal: input.abortAfterDelta ? controller.signal : undefined,
      onTextDelta: input.abortAfterDelta ? () => controller.abort() : undefined,
    })).rejects.toMatchObject({
      name: "AcpRunnerError",
      phase: input.phase,
    });
    const pid = Number(await Deno.readTextFile(pidFile));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(await processIsAlive(pid)).toBe(false);
  } finally {
    await Deno.remove(pidFile).catch(() => {});
  }
}

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

  test("selects the agent's allow option only after explicit approval", async () => {
    const result = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION",
      confirmPermission: async () => "approve",
    });
    expect(result.text).toBe("approved");
  });

  test("maps binary decisions only to one-shot permission options", async () => {
    const approved = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => "approve",
    });
    expect(approved.text).toBe("allow-once");

    const denied = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_SCOPE",
      confirmPermission: async () => "deny",
    });
    expect(denied.text).toBe("reject-once");

    const lateDenied = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_LATE_REJECT",
      confirmPermission: async () => "deny",
    });
    expect(lateDenied.text).toBe("reject-late");

    const fallbackVerdicts: Array<{ decision: string; source: string }> = [];
    const fallbackDenied = await runAcpAgent({
      profile: fixtureProfile(),
      prompt: "FIXTURE_PERMISSION_REJECT_ONLY",
      confirmPermission: async () => "approve",
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
        return "approve";
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
    const decision = Promise.withResolvers<"approve" | "deny">();
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
    decision.resolve("approve");
    await expect(resultPromise).resolves.toMatchObject({
      stopReason: "aborted",
      acpStopReason: "cancelled",
    });
    expect(verdicts).toEqual(["cancel"]);
    expect(confirmationCancelled).toBe(true);
  });

  test("discards a permission confirmation that resolves after prompt timeout", async () => {
    const prompted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<"approve" | "deny">();
    const verdicts: string[] = [];
    let confirmationCancelled = false;
    const resultPromise = runAcpAgent({
      profile: fixtureProfile({ promptTimeoutMs: 100 }),
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
    await expect(resultPromise).rejects.toMatchObject({ phase: "prompt" });
    decision.resolve("approve");
    await Promise.resolve();
    expect(verdicts).toEqual(["cancel"]);
    expect(confirmationCancelled).toBe(true);
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
      confirmPermission: async () => "approve",
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
      confirmPermission: async () => "approve",
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
      confirmPermission: async () => "approve",
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
        return new Promise<"approve" | "deny">((_resolve, reject) => {
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
      confirmPermission: async () => "deny",
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
        return "approve";
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
});
