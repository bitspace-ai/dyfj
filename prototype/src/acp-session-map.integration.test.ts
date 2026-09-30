// AcpSessionHandleMap and startAcpSession against the real fixture agent
// (scripts/acp-fixture-agent.ts): warm-worker reuse, creation failure,
// logical close and cancellation, observed through the fixture's pid file and
// ACP method log. Child processes and environment reads put these in the
// integration tier; the fake-handle cases live in acp-session-map.test.ts.
import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import {
  type AcpExecutionProfile,
  type AcpSessionHandle,
  startAcpSession,
} from "./acp-client.ts";
import { AcpSessionHandleMap } from "./acp-session-map.ts";

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

/** The fixture's full environment with a fixture mode selected. */
function fixtureModeEnvironment(mode: string): Record<string, string> {
  return {
    DENO_DIR: Deno.env.get("DENO_DIR") ??
      join(Deno.env.get("HOME") ?? "/tmp", ".cache/deno"),
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    ACP_FIXTURE_ALLOWED: "yes",
    ACP_FIXTURE_MODE: mode,
  };
}

/** A temp file outside the checkout; removed by the caller. */
function tempPath(): Promise<string> {
  return Deno.makeTempFile({ prefix: "dyfj-acp-session-map-" });
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
  assertStrictEquals(Number.isSafeInteger(pid) && pid > 0, true);
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
  const error = await assertRejects(() => promise);
  for (const [key, value] of Object.entries(expected)) {
    assertEquals(
      (error as Record<string, unknown>)[key],
      value,
      `error.${key}`,
    );
  }
}

describe("AcpSessionHandleMap sequential reuse", () => {
  it("two sequential turns reuse one worker and one ACP session", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
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
        assertStrictEquals(first.stopReason, "stop");
        assertStringIncludes(first.text, "first|");
        assertStrictEquals(await processIsAlive(pid), true);
        assertEquals(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
        ]);

        const second = await map.runTurn({ ...key, prompt: "second turn" });
        assertStrictEquals(second.stopReason, "stop");
        assertStringIncludes(second.text, "first|");
        assertStrictEquals(await readPid(pidFile), pid);
        assertStrictEquals(await processIsAlive(pid), true);
        assertEquals(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
          "session/prompt",
        ]);
      } finally {
        await map.shutdown();
      }
      const pid = Number(await Deno.readTextFile(pidFile));
      assertStrictEquals(await processIsAlive(pid), false);
      assertEquals(await readMethods(methodLog), [
        "initialize",
        "session/new",
        "session/prompt",
        "session/prompt",
        "session/close",
      ]);
    } finally {
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });
});

describe("AcpSessionHandleMap lifecycle", () => {
  it("creation failure removes the placeholder and reaps partial resources", async () => {
    const pidFile = await tempPath();
    try {
      const profile = fixtureProfile({
        initializeTimeoutMs: 400,
        environment: fixtureModeEnvironment("initialize_mute"),
      }, pidFile);
      const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
      try {
        await assertRejectsWithFields(map.acquire(acquireKey(profile)), {
          phase: "initialize",
        });
        assertStrictEquals(map.stateFor(acquireKey(profile)), undefined);
        assertStrictEquals(map.size, 0);
        const pid = await readPid(pidFile);
        assertStrictEquals(await processIsAlive(pid), false);
        // A fake handle stands in for the retry: only the map's bookkeeping
        // after the failed creation is under test here.
        let retryClosed = false;
        const retry: AcpSessionHandle = {
          get isAlive() {
            return !retryClosed;
          },
          durableSessionLoad: false,
          prompt: () =>
            Promise.resolve({
              text: "ok",
              stopReason: "stop",
              capabilities: [],
              elapsedMs: 1,
            }),
          close: () => {
            retryClosed = true;
            return Promise.resolve();
          },
        };
        assertStrictEquals(
          await map.acquire({
            ...acquireKey(profile),
            create: () => Promise.resolve(retry),
          }),
          retry,
        );
      } finally {
        await map.shutdown();
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  it("concurrent close callers receive the same result", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await Deno.writeTextFile(methodLog, "");
      const session = await startAcpSession({
        profile: fixtureProfile({}, pidFile, methodLog),
      });
      try {
        const first = session.close();
        assertStrictEquals(session.isAlive, false);
        const second = session.close();
        assertStrictEquals(second, first);
        assertStrictEquals(await first, undefined);
        assertStrictEquals(await second, undefined);
        assertEquals(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/close",
        ]);
      } finally {
        await session.close().catch(() => {});
        const pid = Number(await Deno.readTextFile(pidFile));
        assertStrictEquals(await processIsAlive(pid), false);
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });

  it("logical closure immediately changes liveness", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await Deno.writeTextFile(methodLog, "");
      const session = await startAcpSession({
        profile: fixtureProfile(
          {
            terminationTimeoutMs: 50,
            environment: fixtureModeEnvironment("session_close_mute"),
          },
          pidFile,
          methodLog,
        ),
      });
      try {
        const first = session.close();
        assertStrictEquals(session.isAlive, false);
        const second = session.close();
        assertStrictEquals(second, first);
        await assertRejectsWithFields(first, { phase: "terminate" });
        await assertRejectsWithFields(second, { phase: "terminate" });
        assertEquals(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/close",
        ]);
      } finally {
        await session.close().catch(() => {});
        const pid = Number(await Deno.readTextFile(pidFile));
        assertStrictEquals(await processIsAlive(pid), false);
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });

  it("a pre-aborted turn finalizes as aborted without creating a handle", async () => {
    const pidFile = await tempPath();
    try {
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
        assertStrictEquals(result.stopReason, "aborted");
        assertStrictEquals(map.size, 0);
        await assertRejects(() => Deno.stat(pidFile), Deno.errors.NotFound);
      } finally {
        await map.shutdown();
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });

  it("cancellation during stalled creation finalizes as aborted and reaps the child", async () => {
    const pidFile = await tempPath();
    try {
      await Deno.remove(pidFile);
      const profile = fixtureProfile({
        initializeTimeoutMs: 2_000,
        environment: fixtureModeEnvironment("initialize_mute"),
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
            if (Date.now() >= deadline) {
              throw new Error("fixture did not start");
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        controller.abort();
        assertObjectMatch(await pending, { stopReason: "aborted" });
        assert(Date.now() - startedAt < 1_000);
        assertStrictEquals(map.size, 0);
        const pid = Number(await Deno.readTextFile(pidFile));
        assertStrictEquals(await processIsAlive(pid), false);
      } finally {
        await map.shutdown();
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });
});

describe("startAcpSession", () => {
  it("cancellation during a prompt retains the live session", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
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
        assertObjectMatch(aborted, {
          text: "partial\n",
          stopReason: "aborted",
        });
        assertStrictEquals(session.isAlive, true);
        const pid = await readPid(pidFile);
        assertStrictEquals(await processIsAlive(pid), true);
        const next = await session.prompt({ prompt: "after cancel" });
        assertStrictEquals(next.stopReason, "stop");
        assertEquals(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
          "session/prompt",
        ]);
      } finally {
        await session.close();
        const pid = Number(await Deno.readTextFile(pidFile));
        assertStrictEquals(await processIsAlive(pid), false);
      }
    } finally {
      await Deno.remove(pidFile).catch(() => {});
      await Deno.remove(methodLog).catch(() => {});
    }
  });
});
