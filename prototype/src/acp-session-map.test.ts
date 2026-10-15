// AcpSessionHandleMap and continuity selection over fake session handles: no
// child process is started, so the profile below is only a map key. The cases
// that drive the real fixture agent live in
// acp-session-map.integration.test.ts.
import { captureRejection } from "../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join } from "node:path";
import process from "node:process";
import {
  type AcpExecutionProfile,
  type AcpPromptInput,
  type AcpRunResult,
  type AcpSessionHandle,
  assertAcpPromptWithinLimit,
} from "./acp-client.ts";
import {
  AcpSessionBusyError,
  AcpSessionCapacityError,
  AcpSessionHandleMap,
  AcpSessionShutdownError,
  canonicalExecutionProfileDigest,
  encodeAcpSessionHandleKey,
  selectAcpContinuity,
} from "./acp-session-map.ts";
import {
  DomainError,
  historyOmissionForDelivery,
  prependHistoryOmissionNotice,
} from "./contract/mod.ts";

/**
 * A well-formed execution profile used only as a map key: every case here
 * supplies its own fake handle, and the unit lane grants no run permission.
 */
function fixtureProfile(
  overrides: Partial<AcpExecutionProfile> = {},
): AcpExecutionProfile {
  return {
    slug: "fixture",
    command: "/nonexistent/dyfj-acp-fixture",
    args: ["run", "scripts/acp-fixture-agent.ts"],
    environment: { ACP_FIXTURE_ALLOWED: "yes" },
    workspace: "/nonexistent/workspace",
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
  const onProcess = (reason: unknown) => {
    failures.push(reason);
  };
  process.on("unhandledRejection", onProcess);
  return {
    failures,
    stop: () => {
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

/** Asserts `promise` rejects with an error carrying each expected field. */
async function assertRejectsWithFields(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  const error = await captureRejection(() => promise);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(
      (error as Record<string, unknown>)[key],
      value,
      `error.${key}`,
    );
  }
}

describe("AcpSessionHandleMap sequential reuse", () => {
  it("[case 24] notice overhead over the prompt bound drops the warm handle before transport and prevents reuse", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    let transportSends = 0;
    let creates = 0;
    const persistedEvents = Object.freeze([{ eventType: "tool_call" }]);
    const firstHandle = fakeHandle({
      prompt: (input) => {
        assertAcpPromptWithinLimit(input.prompt);
        transportSends += 1;
        return Promise.resolve({
          text: "ok",
          stopReason: "stop",
          capabilities: [],
          elapsedMs: 1,
        });
      },
    });
    const omission = historyOmissionForDelivery({
      detectedInHistory: 1,
      malformedToolRecords: 0,
      gapMarkers: 1,
      callsUnknown: true,
      withheldFromProjection: 1,
      projectedPairs: 0,
    }, "warm-no-replay");
    const original = "x".repeat(59_700);
    assertAcpPromptWithinLimit(original);
    const decorated = prependHistoryOmissionNotice(original, omission);
    try {
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "first",
        create: () => {
          creates += 1;
          return Promise.resolve(firstHandle);
        },
      });
      await assert.rejects(
        () =>
          map.runTurn({
            ...acquireKey(profile),
            prompt: decorated,
            reconstructPrompt: () => "must not replace a warm prompt",
            create: () => Promise.resolve(fakeHandle()),
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("ACP prompt exceeded the input limit"),
      );
      assert.strictEqual(transportSends, 1);
      assert.strictEqual(firstHandle.isAlive, false);
      assert.strictEqual(map.size, 0);
      assert.deepStrictEqual(persistedEvents, [{ eventType: "tool_call" }]);
      await map.runTurn({
        ...acquireKey(profile),
        prompt: "later",
        create: () => {
          creates += 1;
          return Promise.resolve(fakeHandle());
        },
      });
      assert.strictEqual(creates, 2);
    } finally {
      await map.shutdown();
    }
  });
});

describe("ACP continuity selection", () => {
  it("a warm handle needs no replay and claims no resume", () => {
    assert.deepStrictEqual(
      selectAcpContinuity({
        warmHandleReused: true,
        priorTurns: true,
        agentAdvertisesSessionLoad: true,
        verifiedResumedExternalSessionId: "external-1",
      }),
      { state: "warm-reused", durableResume: "not-required" },
    );
  });

  it("a session without prior turns is new, not reconstructed", () => {
    assert.deepStrictEqual(
      selectAcpContinuity({
        warmHandleReused: false,
        priorTurns: false,
        agentAdvertisesSessionLoad: false,
      }),
      { state: "new", durableResume: "not-required" },
    );
  });

  it("prior turns without a load-capable runner reconstruct", () => {
    assert.deepStrictEqual(
      selectAcpContinuity({
        warmHandleReused: false,
        priorTurns: true,
        agentAdvertisesSessionLoad: false,
      }),
      {
        state: "reconstructed",
        durableResume: "unavailable-agent-capability",
      },
    );
  });

  it("an advertised load without verified identity still reconstructs", () => {
    assert.deepStrictEqual(
      selectAcpContinuity({
        warmHandleReused: false,
        priorTurns: true,
        agentAdvertisesSessionLoad: true,
      }),
      {
        state: "reconstructed",
        durableResume: "unavailable-client-verification",
      },
    );
  });

  it("a durable resume needs both capability and verified identity", () => {
    assert.deepStrictEqual(
      selectAcpContinuity({
        warmHandleReused: false,
        priorTurns: true,
        agentAdvertisesSessionLoad: true,
        verifiedResumedExternalSessionId: "external-7",
      }),
      { state: "durably-resumed", durableResume: "verified" },
    );
  });
});

describe("AcpSessionHandleMap continuity", () => {
  it("a warm turn keeps the agent's own history and replays nothing", async () => {
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
      assert.deepStrictEqual(states, ["new", "warm-reused"]);
      assert.deepStrictEqual(prompts, ["first turn", "referential follow-up"]);
    } finally {
      await map.shutdown();
    }
  });

  it("a retired handle reconstructs prior turns into the replacement", async () => {
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
      assert.strictEqual(map.size, 0);

      await map.runTurn({
        ...acquireKey(profile),
        prompt: "referential follow-up",
        create: () => Promise.resolve(recordingHandle()),
        reconstructPrompt: () => "transcript + referential follow-up",
        onContinuity: (evidence) => states.push(evidence.state),
      });
      assert.deepStrictEqual(states, ["new", "reconstructed"]);
      assert.deepStrictEqual(prompts, [
        "first turn",
        "transcript + referential follow-up",
      ]);
    } finally {
      await map.shutdown();
    }
  });

  it("a load-capable runner still reconstructs in production", async () => {
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
      assert.deepStrictEqual(evidence, [{
        state: "reconstructed",
        durableResume: "unavailable-client-verification",
      }]);
    } finally {
      await map.shutdown();
    }
  });

  it("the ACP client implements no session/load path", async () => {
    const sources = await Promise.all(
      ["acp-client.ts", "acp-session-map.ts", "external-agent-runtime.ts"].map(
        (file) => readFile(join(import.meta.dirname!, file), "utf8"),
      ),
    );
    for (const source of sources) {
      assert.ok(!source.includes("methods.agent.session.load"));
      assert.ok(!source.includes("loadSession("));
      assert.ok(!source.includes("resumeSession("));
    }
    // The capability is still read as runner-reported evidence.
    assert.ok(
      sources[0].includes("agentCapabilities?.loadSession === true"),
      `expected sources[0] to include "agentCapabilities?.loadSession === true"`,
    );
  });

  it("an unprojectable transcript fails before the agent is prompted", async () => {
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
      await assert.rejects(
        () =>
          map.runTurn({
            ...acquireKey(profile),
            prompt: "referential follow-up",
            create: () => Promise.resolve(handle),
            reconstructPrompt: () => {
              throw new DomainError("reconstruction refused");
            },
          }),
        DomainError,
      );
      assert.strictEqual(prompted, false);
      assert.strictEqual(handle.isAlive, false);
      assert.strictEqual(map.size, 0);
    } finally {
      await map.shutdown();
    }
  });
});

describe("AcpSessionHandleMap lifecycle", () => {
  it("inserts a creating reservation synchronously", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const gate = Promise.withResolvers<AcpSessionHandle>();
    try {
      const first = map.acquire({
        ...acquireKey(profile),
        create: () => gate.promise,
      });
      assert.strictEqual(map.stateFor(acquireKey(profile)), "creating");
      gate.resolve(fakeHandle());
      await first;
      assert.strictEqual(map.stateFor(acquireKey(profile)), "active");
    } finally {
      await map.shutdown();
    }
  });

  it("rejects same-key creating and active acquisition as session busy", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 4, idleTtlMs: 60_000 });
    const gate = Promise.withResolvers<AcpSessionHandle>();
    try {
      const first = map.acquire({
        ...acquireKey(profile),
        create: () => gate.promise,
      });
      await assert.rejects(
        () =>
          map.acquire({
            ...acquireKey(profile),
            create: () => Promise.resolve(fakeHandle()),
          }),
        AcpSessionBusyError,
      );
      const handle = fakeHandle();
      gate.resolve(handle);
      assert.strictEqual(await first, handle);
      await assert.rejects(
        () =>
          map.acquire({
            ...acquireKey(profile),
            create: () => Promise.resolve(fakeHandle()),
          }),
        AcpSessionBusyError,
      );
    } finally {
      await map.shutdown();
    }
  });

  it("reuses an idle handle for a sequential same-key acquire", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const handle = fakeHandle();
    try {
      assert.strictEqual(
        await map.acquire({
          ...acquireKey(profile),
          create: () => Promise.resolve(handle),
        }),
        handle,
      );
      map.release(handle);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
      assert.strictEqual(
        await map.acquire({
          ...acquireKey(profile),
          create: () => Promise.resolve(fakeHandle()),
        }),
        handle,
      );
    } finally {
      await map.shutdown();
    }
  });

  it("isolates handles by session ID, workspace, and profile digest", async () => {
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
      assert.strictEqual(new Set([a, b, c, d]).size, 4);
      assert.notStrictEqual(
        encodeAcpSessionHandleKey({
          sessionId: "s1",
          workspace: profile.workspace,
          profile,
        }),
        encodeAcpSessionHandleKey({
          sessionId: "s1:extra",
          workspace: profile.workspace,
          profile,
        }),
      );
      assert.notStrictEqual(
        canonicalExecutionProfileDigest(profile),
        canonicalExecutionProfileDigest(otherProfile),
      );
    } finally {
      await map.shutdown();
    }
  });

  it("cancellation retains a healthy handle", async () => {
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
      assert.strictEqual(result.stopReason, "aborted");
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
      assert.strictEqual(
        await map.acquire({
          ...acquireKey(profile),
          create: () => Promise.resolve(fakeHandle()),
        }),
        handle,
      );
    } finally {
      await map.shutdown();
    }
  });

  it("protocol failure removes the handle and allows later replacement", async () => {
    const profile = fixtureProfile();
    const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
    const broken = fakeHandle({
      prompt: () =>
        Promise.reject(
          Object.assign(new Error("protocol"), { phase: "protocol" }),
        ),
    });
    const replacement = fakeHandle();
    try {
      await assertRejectsWithFields(
        map.runTurn({
          ...acquireKey(profile),
          prompt: "fail",
          create: () => Promise.resolve(broken),
        }),
        { phase: "protocol" },
      );
      assert.strictEqual(broken.isAlive, false);
      assert.strictEqual(map.stateFor(acquireKey(profile)), undefined);
      assert.strictEqual(
        await map.acquire({
          ...acquireKey(profile),
          create: () => Promise.resolve(replacement),
        }),
        replacement,
      );
    } finally {
      await map.shutdown();
    }
  });

  it("idle TTL closes only an unchanged idle entry", async () => {
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
      assert.ok(stale !== undefined);
      await map.acquire({
        ...acquireKey(profile),
        create: () => Promise.resolve(fakeHandle()),
      });
      assert.strictEqual(handle.isAlive, true);
      stale?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "active");
      map.release(handle);
      const current = [...timers.values()][0];
      current?.();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      assert.strictEqual(handle.isAlive, false);
      assert.strictEqual(map.stateFor(acquireKey(profile)), undefined);
    } finally {
      await map.shutdown();
    }
  });

  it("idle TTL close failure on a dead handle frees capacity without an unhandled rejection", async () => {
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
      assert.deepStrictEqual(captured.failures, []);
      assert.strictEqual(handle.isAlive, false);
      assert.strictEqual(map.size, 0);
      await map.shutdown();
      assert.strictEqual(map.size, 0);
    } finally {
      captured.stop();
    }
  });

  it("idle TTL close failure on a live handle keeps the entry for later shutdown", async () => {
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
      assert.deepStrictEqual(captured.failures, []);
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "closing");
      await assert.rejects(
        () => map.shutdown(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("idle close failed while alive"),
      );
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.size, 1);
    } finally {
      captured.stop();
    }
  });

  it("capacity fails closed without eviction", async () => {
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
      await assert.rejects(
        () =>
          map.acquire({
            ...acquireKey(profile, "s2"),
            create: () => Promise.resolve(second),
          }),
        AcpSessionCapacityError,
      );
      assert.strictEqual(first.isAlive, true);
      assert.strictEqual(map.stateFor(acquireKey(profile, "s1")), "idle");
      assert.strictEqual(map.size, 1);
    } finally {
      await map.shutdown();
    }
  });

  it("shutdown waits for in-flight creation and closes the handle", async () => {
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
    assert.strictEqual(map.stateFor(acquireKey(profile)), "creating");
    const shuttingDown = map.shutdown();
    await Promise.resolve();
    assert.strictEqual(handle.isAlive, true);
    gate.resolve(handle);
    await shuttingDown;
    assert.strictEqual(handle.isAlive, false);
    assert.strictEqual(map.size, 0);
    await assert.rejects(() => pending, AcpSessionShutdownError);
  });

  it("shutdown surfaces a close failure and keeps the live entry", async () => {
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
    await assert.rejects(
      () => map.shutdown(),
      (error: unknown) =>
        error instanceof Error && error.message.includes("close failed"),
    );
    assert.strictEqual(handle.isAlive, true);
    assert.strictEqual(map.size, 1);
  });

  it("shutdown waits for a delayed close before surfacing an earlier failure", async () => {
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
    assert.strictEqual(shutdownSettled, false);
    assert.strictEqual(delayedFinished, false);
    assert.strictEqual(delayed.isAlive, true);
    delay.resolve();
    await assert.rejects(
      () => shuttingDown,
      (error: unknown) =>
        error instanceof Error && error.message.includes("fast close failed"),
    );
    assert.strictEqual(delayedFinished, true);
    assert.strictEqual(shutdownSettled, true);
    assert.strictEqual(delayed.isAlive, false);
    assert.strictEqual(map.size, 0);
  });

  it("shutdown rejects new acquisition and reaps every handle", async () => {
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
    assert.strictEqual(handles[0].isAlive, false);
    assert.strictEqual(handles[1].isAlive, false);
    assert.strictEqual(map.size, 0);
    await assert.rejects(
      () =>
        map.acquire({
          ...acquireKey(profile, "s3"),
          create: () => Promise.resolve(fakeHandle()),
        }),
      AcpSessionShutdownError,
    );
  });

  it("replacing a dead idle handle verifies the route once, not twice", async () => {
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
      assert.strictEqual(dead.isAlive, false);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
      const result = await map.runTurn({
        ...acquireKey(profile),
        prompt: "replace",
        onRouteVerified,
        create: async () => {
          onRouteVerified();
          return live;
        },
      });
      assert.strictEqual(result.stopReason, "stop");
      assert.strictEqual(routeCalls, 1);
      assert.strictEqual(live.isAlive, true);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
    } finally {
      await map.shutdown();
    }
  });

  it("a pre-aborted reused turn stays aborted and retains the healthy handle", async () => {
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
      assert.strictEqual(result.stopReason, "aborted");
      assert.strictEqual(routeCalls, 0);
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
    } finally {
      await map.shutdown();
    }
  });

  it("abort during reused route-evidence replay stays aborted and retains the handle", async () => {
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
      assert.strictEqual(result.stopReason, "aborted");
      assert.strictEqual(handle.isAlive, true);
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.stateFor(acquireKey(profile)), "idle");
    } finally {
      await map.shutdown();
    }
  });

  it("a never-settling reused route callback is bounded by the session timeout", async () => {
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
      await assertRejectsWithFields(
        map.runTurn({
          ...acquireKey(profile),
          prompt: "second",
          onRouteVerified: () => new Promise(() => {}),
        }),
        {
          name: "AcpRunnerError",
          phase: "authenticate",
        },
      );
      assert.ok(Date.now() - startedAt < 1_000);
      assert.strictEqual(map.size, 0);
      assert.strictEqual(map.stateFor(acquireKey(profile)), undefined);
    } finally {
      await map.shutdown().catch(() => {});
    }
  });

  it("a reused route callback that outlives the timeout is aborted and performs no late write", async () => {
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
      await assertRejectsWithFields(
        map.runTurn({
          ...acquireKey(profile),
          prompt: "second",
          onRouteVerified: async (_evidence, signal) => {
            replaySignal = signal;
            await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
            if (signal.aborted) return;
            lateWrite = true;
          },
        }),
        {
          name: "AcpRunnerError",
          phase: "authenticate",
        },
      );
      assert.ok(Date.now() - startedAt < 1_000);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
      assert.strictEqual(replaySignal?.aborted, true);
      assert.strictEqual(lateWrite, false);
      assert.strictEqual(map.size, 0);
    } finally {
      await map.shutdown().catch(() => {});
    }
  });
});
