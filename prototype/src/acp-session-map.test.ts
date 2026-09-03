import { describe, expect, test } from "vitest";
import { join } from "node:path";
import process from "node:process";
import {
  type AcpExecutionProfile,
  type AcpPromptInput,
  type AcpRunResult,
  type AcpSessionHandle,
  startAcpSession,
} from "./acp-client";
import {
  AcpSessionBusyError,
  AcpSessionCapacityError,
  AcpSessionHandleMap,
  AcpSessionShutdownError,
  canonicalExecutionProfileDigest,
  encodeAcpSessionHandleKey,
  selectAcpContinuity,
} from "./acp-session-map";
import { DomainError } from "./turn-contract";

function fixtureProfile(
  overrides: Partial<AcpExecutionProfile> = {},
  pidFile?: string,
  methodLog?: string,
): AcpExecutionProfile {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const writePaths = [pidFile, methodLog].filter((path): path is string =>
    path !== undefined
  );
  return {
    slug: "fixture",
    command: Deno.execPath(),
    args: [
      "run",
      "--cached-only",
      "--allow-env=ACP_FIXTURE_ALLOWED,ACP_FIXTURE_MODE,ACP_FIXTURE_AUTH_STATUS,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK",
      "--allow-run=/bin/kill",
      ...writePaths.map((path) => `--allow-write=${path}`),
      join(import.meta.dirname!, "../scripts/acp-fixture-agent.ts"),
      ...(pidFile === undefined ? [] : [`--pid-file=${pidFile}`]),
      ...(methodLog === undefined ? [] : [`--method-log=${methodLog}`]),
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

async function readPid(path: string): Promise<number> {
  const pid = Number(await Deno.readTextFile(path));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return pid;
}

async function readMethods(path: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(path)).split("\n").filter((line) =>
      line.length > 0
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function fakeHandle(options: {
  prompt?: (input: AcpPromptInput) => Promise<AcpRunResult>;
  closeDelayMs?: number;
  closeWait?: Promise<void>;
  closeError?: Error;
  stayAliveOnCloseError?: boolean;
  keepAliveDuringClose?: boolean;
  routeEvidence?: AcpSessionHandle["routeEvidence"];
  durableSessionLoad?: boolean;
} = {}): AcpSessionHandle {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const markClosedUnlessHeld = () => {
    if (!options.stayAliveOnCloseError || options.closeError === undefined) {
      closed = true;
    }
  };
  return {
    get isAlive() {
      return !closed;
    },
    get routeEvidence() {
      return options.routeEvidence;
    },
    get durableSessionLoad() {
      return options.durableSessionLoad ?? false;
    },
    prompt: options.prompt ?? (() =>
      Promise.resolve({
        text: "ok",
        stopReason: "stop",
        capabilities: [],
        elapsedMs: 1,
      })),
    close() {
      if (!options.keepAliveDuringClose) markClosedUnlessHeld();
      closePromise ??= (async () => {
        try {
          if (options.closeWait !== undefined) await options.closeWait;
          if (options.closeDelayMs !== undefined) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.closeDelayMs)
            );
          }
          if (options.closeError !== undefined) throw options.closeError;
        } finally {
          if (options.keepAliveDuringClose) markClosedUnlessHeld();
        }
      })();
      return closePromise;
    },
  };
}

function fakeIdleTimers(): {
  timers: Map<unknown, () => void>;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
} {
  const timers = new Map<unknown, () => void>();
  let nextId = 1;
  return {
    timers,
    setTimeout: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
}

function captureUnhandledRejections(): {
  failures: unknown[];
  stop: () => void;
} {
  const failures: unknown[] = [];
  const onEvent = (event: PromiseRejectionEvent) => {
    failures.push(event.reason);
    event.preventDefault();
  };
  const onProcess = (reason: unknown) => {
    failures.push(reason);
  };
  globalThis.addEventListener("unhandledrejection", onEvent);
  process.on("unhandledRejection", onProcess);
  return {
    failures,
    stop: () => {
      globalThis.removeEventListener("unhandledrejection", onEvent);
      process.off("unhandledRejection", onProcess);
    },
  };
}

function acquireKey(
  profile: AcpExecutionProfile,
  sessionId = "session-1",
): { sessionId: string; workspace: string; profile: AcpExecutionProfile } {
  return { sessionId, workspace: profile.workspace, profile };
}

describe("AcpSessionHandleMap sequential reuse", () => {
  test("two sequential turns reuse one worker and one ACP session", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const methodLog = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.writeTextFile(methodLog, "");
    const profile = fixtureProfile({}, pidFile, methodLog);
    const map = new AcpSessionHandleMap({
      capacity: 2,
      idleTtlMs: 60_000,
    });
    try {
      const key = acquireKey(profile, "workbench-session-1");
      const first = await map.runTurn({ ...key, prompt: "first turn" });
      const pid = await readPid(pidFile);
      expect(first.stopReason).toBe("stop");
      expect(first.text).toContain("first|");
      expect(await processIsAlive(pid)).toBe(true);
      expect(await readMethods(methodLog)).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
      ]);

      const second = await map.runTurn({ ...key, prompt: "second turn" });
      expect(second.stopReason).toBe("stop");
      expect(second.text).toContain("first|");
      expect(await readPid(pidFile)).toBe(pid);
      expect(await processIsAlive(pid)).toBe(true);
      expect(await readMethods(methodLog)).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
        "session/prompt",
      ]);
    } finally {
      await map.shutdown();
    }
    const pid = Number(await Deno.readTextFile(pidFile));
    expect(await processIsAlive(pid)).toBe(false);
    expect(await readMethods(methodLog)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/prompt",
      "session/close",
    ]);
    await Deno.remove(pidFile).catch(() => {});
    await Deno.remove(methodLog).catch(() => {});
  });
});

describe("ACP continuity selection", () => {
  test("a warm handle needs no replay and claims no resume", () => {
    expect(selectAcpContinuity({
      warmHandleReused: true,
      priorTurns: true,
      agentAdvertisesSessionLoad: true,
      verifiedResumedExternalSessionId: "external-1",
    })).toEqual({ state: "warm-reused", durableResume: "not-required" });
  });

  test("a session without prior turns is new, not reconstructed", () => {
    expect(selectAcpContinuity({
      warmHandleReused: false,
      priorTurns: false,
      agentAdvertisesSessionLoad: false,
    })).toEqual({ state: "new", durableResume: "not-required" });
  });

  test("prior turns without a load-capable runner reconstruct", () => {
    expect(selectAcpContinuity({
      warmHandleReused: false,
      priorTurns: true,
      agentAdvertisesSessionLoad: false,
    })).toEqual({
      state: "reconstructed",
      durableResume: "unavailable-agent-capability",
    });
  });

  test("an advertised load without verified identity still reconstructs", () => {
    expect(selectAcpContinuity({
      warmHandleReused: false,
      priorTurns: true,
      agentAdvertisesSessionLoad: true,
    })).toEqual({
      state: "reconstructed",
      durableResume: "unavailable-client-verification",
    });
  });

  test("a durable resume needs both capability and verified identity", () => {
    expect(selectAcpContinuity({
      warmHandleReused: false,
      priorTurns: true,
      agentAdvertisesSessionLoad: true,
      verifiedResumedExternalSessionId: "external-7",
    })).toEqual({ state: "durably-resumed", durableResume: "verified" });
  });
});

describe("AcpSessionHandleMap continuity", () => {
  test("a warm turn keeps the agent's own history and replays nothing", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const prompts: string[] = [];
    const handle = fakeHandle({
      prompt: (input) => {
        prompts.push(input.prompt);
        return Promise.resolve({
          text: "ok",
          stopReason: "stop",
          capabilities: [],
          elapsedMs: 1,
        });
      },
    });
    const states: string[] = [];
    try {
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "first turn",
        create: () => Promise.resolve(handle),
        onContinuity: (evidence) => states.push(evidence.state),
      });
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "referential follow-up",
        create: () => Promise.resolve(fakeHandle()),
        reconstructPrompt: () => "must-not-be-replayed",
        onContinuity: (evidence) => states.push(evidence.state),
      });
      expect(states).toEqual(["new", "warm-reused"]);
      expect(prompts).toEqual(["first turn", "referential follow-up"]);
    } finally {
      await map.shutdown();
    }
  });

  test("a retired handle reconstructs prior turns into the replacement", async () => {
    const profile = fixtureProfile();
    const { timers, setTimeout, clearTimeout } = fakeIdleTimers();
    const map = new AcpSessionHandleMap({
      capacity: 2,
      idleTtlMs: 1_000,
      setTimeout,
      clearTimeout,
    });
    const prompts: string[] = [];
    const recordingHandle = () =>
      fakeHandle({
        prompt: (input) => {
          prompts.push(input.prompt);
          return Promise.resolve({
            text: "ok",
            stopReason: "stop",
            capabilities: [],
            elapsedMs: 1,
          });
        },
      });
    const states: string[] = [];
    try {
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "first turn",
        create: () => Promise.resolve(recordingHandle()),
        onContinuity: (evidence) => states.push(evidence.state),
      });
      const idle = [...timers.values()][0];
      idle?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      expect(map.size).toBe(0);

      await map.runTurn({
        ...acquireKey(profile),
        prompt: "referential follow-up",
        create: () => Promise.resolve(recordingHandle()),
        reconstructPrompt: () => "transcript + referential follow-up",
        onContinuity: (evidence) => states.push(evidence.state),
      });
      expect(states).toEqual(["new", "reconstructed"]);
      expect(prompts).toEqual([
        "first turn",
        "transcript + referential follow-up",
      ]);
    } finally {
      await map.shutdown();
    }
  });

  test("a load-capable runner still reconstructs in production", async () => {
    // `durably-resumed` stays unreachable through the production path: even a
    // runner advertising `session/load` cannot produce it, because nothing
    // here loads a session or verifies a resumed external session identity.
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const evidence: unknown[] = [];
    try {
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "referential follow-up",
        create: () => Promise.resolve(fakeHandle({ durableSessionLoad: true })),
        reconstructPrompt: () => "transcript + referential follow-up",
        onContinuity: (value) => evidence.push(value),
      });
      expect(evidence).toEqual([{
        state: "reconstructed",
        durableResume: "unavailable-client-verification",
      }]);
    } finally {
      await map.shutdown();
    }
  });

  test("the ACP client implements no session/load path", async () => {
    const sources = await Promise.all(
      ["acp-client.ts", "acp-session-map.ts", "external-agent-runtime.ts"].map(
        (file) => Deno.readTextFile(join(import.meta.dirname!, file)),
      ),
    );
    for (const source of sources) {
      expect(source).not.toContain("methods.agent.session.load");
      expect(source).not.toContain("loadSession(");
      expect(source).not.toContain("resumeSession(");
    }
    // The capability is still read as runner-reported evidence.
    expect(sources[0]).toContain("agentCapabilities?.loadSession === true");
  });

  test("an unprojectable transcript fails before the agent is prompted", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let prompted = false;
    const handle = fakeHandle({
      prompt: () => {
        prompted = true;
        return Promise.resolve({
          text: "ok",
          stopReason: "stop",
          capabilities: [],
          elapsedMs: 1,
        });
      },
    });
    try {
      await expect(map.runTurn({
        ...acquireKey(profile),
        prompt: "referential follow-up",
        create: () => Promise.resolve(handle),
        reconstructPrompt: () => {
          throw new DomainError("reconstruction refused");
        },
      })).rejects.toBeInstanceOf(DomainError);
      expect(prompted).toBe(false);
      expect(handle.isAlive).toBe(false);
      expect(map.size).toBe(0);
    } finally {
      await map.shutdown();
    }
  });
});

describe("AcpSessionHandleMap lifecycle", () => {
  test("inserts a creating reservation synchronously", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const gate = Promise.withResolvers<AcpSessionHandle>();
    try {
      const first = map.acquire({
        ...acquireKey(profile),
        create: () => gate.promise,
      });
      expect(map.stateFor(acquireKey(profile))).toBe("creating");
      gate.resolve(fakeHandle());
      await first;
      expect(map.stateFor(acquireKey(profile))).toBe("active");
    } finally {
      await map.shutdown();
    }
  });

  test("rejects same-key creating and active acquisition as session busy", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 4, idleTtlMs: 60_000 });
    const gate = Promise.withResolvers<AcpSessionHandle>();
    try {
      const first = map.acquire({
        ...acquireKey(profile),
        create: () => gate.promise,
      });
      await expect(map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      })).rejects.toBeInstanceOf(AcpSessionBusyError);
      const handle = fakeHandle();
      gate.resolve(handle);
      expect(await first).toBe(handle);
      await expect(map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      })).rejects.toBeInstanceOf(AcpSessionBusyError);
    } finally {
      await map.shutdown();
    }
  });

  test("creation failure removes the placeholder and reaps partial resources", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const profile = fixtureProfile({
      initializeTimeoutMs: 400,
      environment: {
        DENO_DIR: Deno.env.get("DENO_DIR") ??
          join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        ACP_FIXTURE_ALLOWED: "yes",
        ACP_FIXTURE_MODE: "initialize_mute",
      },
    }, pidFile);
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    try {
      await expect(map.acquire(acquireKey(profile))).rejects.toMatchObject({
        phase: "initialize",
      });
      expect(map.stateFor(acquireKey(profile))).toBeUndefined();
      expect(map.size).toBe(0);
      const pid = await readPid(pidFile);
      expect(await processIsAlive(pid)).toBe(false);
      const retry = fakeHandle();
      expect(await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(retry),
      })).toBe(retry);
    } finally {
      await map.shutdown();
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  test("reuses an idle handle for a sequential same-key acquire", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle();
    try {
      expect(await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      })).toBe(handle);
      map.release(handle);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
      expect(await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      })).toBe(handle);
    } finally {
      await map.shutdown();
    }
  });

  test("isolates handles by session ID, workspace, and profile digest", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 8, idleTtlMs: 60_000 });
    const handles = [fakeHandle(), fakeHandle(), fakeHandle(), fakeHandle()];
    try {
      const a = await map.acquire({
        sessionId: "s1",
        workspace: profile.workspace,
        profile,
        create: () => Promise.resolve(handles[0]),
      });
      const b = await map.acquire({
        sessionId: "s2",
        workspace: profile.workspace,
        profile,
        create: () => Promise.resolve(handles[1]),
      });
      const otherWorkspace = join(profile.workspace, "other");
      const c = await map.acquire({
        sessionId: "s1",
        workspace: otherWorkspace,
        profile: { ...profile, workspace: otherWorkspace },
        create: () => Promise.resolve(handles[2]),
      });
      const otherProfile = { ...profile, slug: "other-fixture" };
      const d = await map.acquire({
        sessionId: "s1",
        workspace: profile.workspace,
        profile: otherProfile,
        create: () => Promise.resolve(handles[3]),
      });
      expect(new Set([a, b, c, d]).size).toBe(4);
      expect(encodeAcpSessionHandleKey({
        sessionId: "s1",
        workspace: profile.workspace,
        profile,
      })).not.toBe(encodeAcpSessionHandleKey({
        sessionId: "s1:extra",
        workspace: profile.workspace,
        profile,
      }));
      expect(canonicalExecutionProfileDigest(profile)).not.toBe(
        canonicalExecutionProfileDigest(otherProfile),
      );
    } finally {
      await map.shutdown();
    }
  });

  test("cancellation retains a healthy handle", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle({
      prompt: async () => ({
        text: "partial\n",
        stopReason: "aborted",
        capabilities: [],
        elapsedMs: 2,
      }),
    });
    try {
      const result = await map.runTurn({
        ...acquireKey(profile),
        prompt: "cancel me",
        create: () => Promise.resolve(handle),
      });
      expect(result.stopReason).toBe("aborted");
      expect(handle.isAlive).toBe(true);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
      expect(await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      })).toBe(handle);
    } finally {
      await map.shutdown();
    }
  });

  test("protocol failure removes the handle and allows later replacement", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const broken = fakeHandle({
      prompt: () => Promise.reject(Object.assign(new Error("protocol"), { phase: "protocol" })),
    });
    const replacement = fakeHandle();
    try {
      await expect(map.runTurn({
        ...acquireKey(profile),
        prompt: "fail",
        create: () => Promise.resolve(broken),
      })).rejects.toMatchObject({ phase: "protocol" });
      expect(broken.isAlive).toBe(false);
      expect(map.stateFor(acquireKey(profile))).toBeUndefined();
      expect(await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(replacement),
      })).toBe(replacement);
    } finally {
      await map.shutdown();
    }
  });

  test("idle TTL closes only an unchanged idle entry", async () => {
    const profile = fixtureProfile();
    const { timers, setTimeout, clearTimeout } = fakeIdleTimers();
    const map = new AcpSessionHandleMap({
      capacity: 2,
      idleTtlMs: 1_000,
      setTimeout,
      clearTimeout,
    });
    const handle = fakeHandle();
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const stale = [...timers.values()][0];
      expect(stale).toBeDefined();
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      });
      expect(handle.isAlive).toBe(true);
      stale?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      expect(handle.isAlive).toBe(true);
      expect(map.stateFor(acquireKey(profile))).toBe("active");
      map.release(handle);
      const current = [...timers.values()][0];
      current?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      expect(handle.isAlive).toBe(false);
      expect(map.stateFor(acquireKey(profile))).toBeUndefined();
    } finally {
      await map.shutdown();
    }
  });

  test("idle TTL close failure on a dead handle frees capacity without an unhandled rejection", async () => {
    const profile = fixtureProfile();
    const { timers, setTimeout, clearTimeout } = fakeIdleTimers();
    const map = new AcpSessionHandleMap({
      capacity: 1,
      idleTtlMs: 1_000,
      setTimeout,
      clearTimeout,
    });
    const handle = fakeHandle({ closeError: new Error("idle close failed") });
    const captured = captureUnhandledRejections();
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const idle = [...timers.values()][0];
      idle?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      expect(captured.failures).toEqual([]);
      expect(handle.isAlive).toBe(false);
      expect(map.size).toBe(0);
      await map.shutdown();
      expect(map.size).toBe(0);
    } finally {
      captured.stop();
    }
  });

  test("idle TTL close failure on a live handle keeps the entry for later shutdown", async () => {
    const profile = fixtureProfile();
    const { timers, setTimeout, clearTimeout } = fakeIdleTimers();
    const map = new AcpSessionHandleMap({
      capacity: 1,
      idleTtlMs: 1_000,
      setTimeout,
      clearTimeout,
    });
    const handle = fakeHandle({
      closeError: new Error("idle close failed while alive"),
      stayAliveOnCloseError: true,
    });
    const captured = captureUnhandledRejections();
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const idle = [...timers.values()][0];
      idle?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      expect(captured.failures).toEqual([]);
      expect(handle.isAlive).toBe(true);
      expect(map.size).toBe(1);
      expect(map.stateFor(acquireKey(profile))).toBe("closing");
      await expect(map.shutdown()).rejects.toThrow(
        "idle close failed while alive",
      );
      expect(handle.isAlive).toBe(true);
      expect(map.size).toBe(1);
    } finally {
      captured.stop();
    }
  });

  test("capacity fails closed without eviction", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 1, idleTtlMs: 60_000 });
    const first = fakeHandle();
    const second = fakeHandle();
    try {
      await map.acquire({
        ...acquireKey(profile, "s1"),
        create: () => Promise.resolve(first),
      });
      map.release(first);
      await expect(map.acquire({
        ...acquireKey(profile, "s2"),
        create: () => Promise.resolve(second),
      })).rejects.toBeInstanceOf(AcpSessionCapacityError);
      expect(first.isAlive).toBe(true);
      expect(map.stateFor(acquireKey(profile, "s1"))).toBe("idle");
      expect(map.size).toBe(1);
    } finally {
      await map.shutdown();
    }
  });

  test("concurrent close callers receive the same result", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const methodLog = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.writeTextFile(methodLog, "");
    const session = await startAcpSession({
      profile: fixtureProfile({}, pidFile, methodLog),
    });
    try {
      const first = session.close();
      expect(session.isAlive).toBe(false);
      const second = session.close();
      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(await readMethods(methodLog)).toEqual([
        "initialize",
        "session/new",
        "session/close",
      ]);
    } finally {
      await session.close().catch(() => {});
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(await processIsAlive(pid)).toBe(false);
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });

  test("logical closure immediately changes liveness", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const methodLog = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.writeTextFile(methodLog, "");
    const session = await startAcpSession({
      profile: fixtureProfile({
        terminationTimeoutMs: 50,
        environment: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          ACP_FIXTURE_ALLOWED: "yes",
          ACP_FIXTURE_MODE: "session_close_mute",
        },
      }, pidFile, methodLog),
    });
    try {
      const first = session.close();
      expect(session.isAlive).toBe(false);
      const second = session.close();
      expect(second).toBe(first);
      await expect(first).rejects.toMatchObject({ phase: "terminate" });
      await expect(second).rejects.toMatchObject({ phase: "terminate" });
      expect(await readMethods(methodLog)).toEqual([
        "initialize",
        "session/new",
        "session/close",
      ]);
    } finally {
      await session.close().catch(() => {});
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(await processIsAlive(pid)).toBe(false);
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });

  test("shutdown waits for in-flight creation and closes the handle", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({
      capacity: 2,
      idleTtlMs: 60_000,
      shutdownTimeoutMs: 2_000,
    });
    const gate = Promise.withResolvers<AcpSessionHandle>();
    const handle = fakeHandle();
    const pending = map.acquire({
      ...acquireKey(profile),
      create: () => gate.promise,
    });
    expect(map.stateFor(acquireKey(profile))).toBe("creating");
    const shuttingDown = map.shutdown();
    await Promise.resolve();
    expect(handle.isAlive).toBe(true);
    gate.resolve(handle);
    await shuttingDown;
    expect(handle.isAlive).toBe(false);
    expect(map.size).toBe(0);
    await expect(pending).rejects.toBeInstanceOf(AcpSessionShutdownError);
  });

  test("shutdown surfaces a close failure and keeps the live entry", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle({
      closeError: new Error("close failed"),
      stayAliveOnCloseError: true,
    });
    await map.acquire({
      ...acquireKey(profile),
      create: () => Promise.resolve(handle),
    });
    await expect(map.shutdown()).rejects.toThrow("close failed");
    expect(handle.isAlive).toBe(true);
    expect(map.size).toBe(1);
  });

  test("shutdown waits for a delayed close before surfacing an earlier failure", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 4, idleTtlMs: 60_000 });
    const delay = Promise.withResolvers<void>();
    let delayedFinished = false;
    const failing = fakeHandle({ closeError: new Error("fast close failed") });
    const delayed = fakeHandle({
      keepAliveDuringClose: true,
      closeWait: delay.promise.then(() => {
        delayedFinished = true;
      }),
    });
    await map.acquire({
      ...acquireKey(profile, "fast"),
      create: () => Promise.resolve(failing),
    });
    await map.acquire({
      ...acquireKey(profile, "slow"),
      create: () => Promise.resolve(delayed),
    });
    let shutdownSettled = false;
    const shuttingDown = map.shutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(delayedFinished).toBe(false);
    expect(delayed.isAlive).toBe(true);
    delay.resolve();
    await expect(shuttingDown).rejects.toThrow("fast close failed");
    expect(delayedFinished).toBe(true);
    expect(shutdownSettled).toBe(true);
    expect(delayed.isAlive).toBe(false);
    expect(map.size).toBe(0);
  });

  test("shutdown rejects new acquisition and reaps every handle", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 4, idleTtlMs: 60_000 });
    const handles = [fakeHandle(), fakeHandle()];
    await map.acquire({
      ...acquireKey(profile, "s1"),
      create: () => Promise.resolve(handles[0]),
    });
    await map.acquire({
      ...acquireKey(profile, "s2"),
      create: () => Promise.resolve(handles[1]),
    });
    map.release(handles[1]);
    await map.shutdown();
    expect(handles[0].isAlive).toBe(false);
    expect(handles[1].isAlive).toBe(false);
    expect(map.size).toBe(0);
    await expect(map.acquire({
      ...acquireKey(profile, "s3"),
      create: () => Promise.resolve(fakeHandle()),
    })).rejects.toBeInstanceOf(AcpSessionShutdownError);
  });

  test("a pre-aborted turn finalizes as aborted without creating a handle", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.remove(pidFile);
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await map.runTurn({
        ...acquireKey(fixtureProfile({}, pidFile)),
        prompt: "unused",
        abortSignal: controller.signal,
      });
      expect(result.stopReason).toBe("aborted");
      expect(map.size).toBe(0);
      await expect(Deno.stat(pidFile)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await map.shutdown();
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  test("replacing a dead idle handle verifies the route once, not twice", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const dead = fakeHandle({
      routeEvidence: { source: "profile_declared" },
    });
    const live = fakeHandle({
      routeEvidence: { source: "profile_declared" },
    });
    let routeCalls = 0;
    const onRouteVerified = () => {
      routeCalls += 1;
    };
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(dead),
      });
      map.release(dead);
      await dead.close();
      expect(dead.isAlive).toBe(false);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
      const result = await map.runTurn({
        ...acquireKey(profile),
        prompt: "replace",
        onRouteVerified,
        create: async () => {
          onRouteVerified();
          return live;
        },
      });
      expect(result.stopReason).toBe("stop");
      expect(routeCalls).toBe(1);
      expect(live.isAlive).toBe(true);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
    } finally {
      await map.shutdown();
    }
  });

  test("a pre-aborted reused turn stays aborted and retains the healthy handle", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let routeCalls = 0;
    const handle = fakeHandle({
      routeEvidence: { source: "profile_declared" },
      prompt: () => Promise.reject(new Error("prompt should not run")),
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const result = await map.runTurn({
        ...acquireKey(profile),
        prompt: "second",
        abortSignal: controller.signal,
        onRouteVerified: () => {
          routeCalls += 1;
        },
      });
      expect(result.stopReason).toBe("aborted");
      expect(routeCalls).toBe(0);
      expect(handle.isAlive).toBe(true);
      expect(map.size).toBe(1);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
    } finally {
      await map.shutdown();
    }
  });

  test("abort during reused route-evidence replay stays aborted and retains the handle", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle({
      routeEvidence: { source: "profile_declared" },
      prompt: () => Promise.reject(new Error("prompt should not run")),
    });
    const controller = new AbortController();
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const result = await map.runTurn({
        ...acquireKey(profile),
        prompt: "second",
        abortSignal: controller.signal,
        onRouteVerified: () => {
          controller.abort();
          return Promise.reject(
            new DOMException("Event write aborted", "AbortError"),
          );
        },
      });
      expect(result.stopReason).toBe("aborted");
      expect(handle.isAlive).toBe(true);
      expect(map.size).toBe(1);
      expect(map.stateFor(acquireKey(profile))).toBe("idle");
    } finally {
      await map.shutdown();
    }
  });

  test("a never-settling reused route callback is bounded by the session timeout", async () => {
    const profile = fixtureProfile({ sessionTimeoutMs: 50 });
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle({
      routeEvidence: { source: "profile_declared" },
      prompt: () => Promise.reject(new Error("prompt should not run")),
    });
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const startedAt = Date.now();
      await expect(map.runTurn({
        ...acquireKey(profile),
        prompt: "second",
        onRouteVerified: () => new Promise(() => {}),
      })).rejects.toMatchObject({
        name: "AcpRunnerError",
        phase: "authenticate",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(map.size).toBe(0);
      expect(map.stateFor(acquireKey(profile))).toBeUndefined();
    } finally {
      await map.shutdown().catch(() => {});
    }
  });

  test("a reused route callback that outlives the timeout is aborted and performs no late write", async () => {
    const profile = fixtureProfile({ sessionTimeoutMs: 20 });
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle({
      routeEvidence: { source: "profile_declared" },
      prompt: () => Promise.reject(new Error("prompt should not run")),
    });
    let replaySignal: AbortSignal | undefined;
    let lateWrite = false;
    try {
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(handle),
      });
      map.release(handle);
      const startedAt = Date.now();
      await expect(map.runTurn({
        ...acquireKey(profile),
        prompt: "second",
        onRouteVerified: async (_evidence, signal) => {
          replaySignal = signal;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
          if (signal.aborted) return;
          lateWrite = true;
        },
      })).rejects.toMatchObject({
        name: "AcpRunnerError",
        phase: "authenticate",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
      expect(replaySignal?.aborted).toBe(true);
      expect(lateWrite).toBe(false);
      expect(map.size).toBe(0);
    } finally {
      await map.shutdown().catch(() => {});
    }
  });

  test("cancellation during stalled creation finalizes as aborted and reaps the child", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.remove(pidFile);
    const home = Deno.env.get("HOME") ?? "/tmp";
    const profile = fixtureProfile({
      initializeTimeoutMs: 2_000,
      environment: {
        DENO_DIR: Deno.env.get("DENO_DIR") ?? join(home, ".cache/deno"),
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        ACP_FIXTURE_ALLOWED: "yes",
        ACP_FIXTURE_MODE: "initialize_mute",
      },
    }, pidFile);
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const pending = map.runTurn({
        ...acquireKey(profile),
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
      await expect(pending).resolves.toMatchObject({ stopReason: "aborted" });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(map.size).toBe(0);
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(await processIsAlive(pid)).toBe(false);
    } finally {
      await map.shutdown();
      await Deno.remove(pidFile).catch(() => {});
    }
  });
});

describe("startAcpSession", () => {
  test("cancellation during a prompt retains the live session", async () => {
    const pidFile = await Deno.makeTempFile({ dir: Deno.cwd() });
    const methodLog = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.writeTextFile(methodLog, "");
    const session = await startAcpSession({
      profile: fixtureProfile({}, pidFile, methodLog),
    });
    const controller = new AbortController();
    try {
      const aborted = await session.prompt({
        prompt: "FIXTURE_CANCEL",
        abortSignal: controller.signal,
        onTextDelta: () => controller.abort(),
      });
      expect(aborted).toMatchObject({ text: "partial\n", stopReason: "aborted" });
      expect(session.isAlive).toBe(true);
      const pid = await readPid(pidFile);
      expect(await processIsAlive(pid)).toBe(true);
      const next = await session.prompt({ prompt: "after cancel" });
      expect(next.stopReason).toBe("stop");
      expect(await readMethods(methodLog)).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
        "session/prompt",
      ]);
    } finally {
      await session.close();
      const pid = Number(await Deno.readTextFile(pidFile));
      expect(await processIsAlive(pid)).toBe(false);
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });
});
