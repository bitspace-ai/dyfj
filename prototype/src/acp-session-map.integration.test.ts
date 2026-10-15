// AcpSessionHandleMap and startAcpSession against the real fixture agent
// (scripts/acp-fixture-agent.ts): warm-worker reuse, creation failure,
// logical close and cancellation, observed through the fixture's pid file and
// ACP method log. Child processes and environment reads put these in the
// integration tier; the fake-handle cases live in acp-session-map.test.ts.
import { captureRejection } from "../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
  type AcpSessionHandle,
  startAcpSession,
} from "./acp-client.ts";
import { AcpSessionHandleMap } from "./acp-session-map.ts";
import { fixtureAgentCommand } from "./acp-fixture-command.ts";

function fixtureProfile(
  overrides: Partial<AcpExecutionProfile> = {},
  pidFile?: string,
  methodLog?: string,
): AcpExecutionProfile {
  const home = process.env.HOME ?? "/tmp";
  const writePaths = [pidFile, methodLog].filter((path): path is string =>
    path !== undefined
  );
  return {
    slug: "fixture",
    ...fixtureAgentCommand({
      grants: [
        "--allow-run=/bin/kill",
        ...writePaths.map((path) => `--allow-write=${path}`),
      ],
      scriptArgs: [
        ...(pidFile === undefined ? [] : [`--pid-file=${pidFile}`]),
        ...(methodLog === undefined ? [] : [`--method-log=${methodLog}`]),
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

/** The fixture's full environment with a fixture mode selected. */
function fixtureModeEnvironment(mode: string): Record<string, string> {
  return {
    DENO_DIR: process.env.DENO_DIR ??
      join(process.env.HOME ?? "/tmp", ".cache/deno"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ACP_FIXTURE_ALLOWED: "yes",
    ACP_FIXTURE_MODE: mode,
  };
}

/**
 * A new empty file outside the checkout, alone in its own temp directory;
 * the caller removes it with `removeTempPath`.
 */
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-acp-session-map-"));
  const path = join(dir, "file");
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return path;
}

/** Removes a `tempPath` file and the directory made for it. */
function removeTempPath(path: string): Promise<void> {
  return rm(dirname(path), { recursive: true, force: true });
}

// Runs the ps probe to its exit. Cwd and stdin are inherited, stdout and
// stderr are discarded. Only a probe that cannot start fails: spawn reports
// that as an `error` event. `close` fires once the child has exited and its
// streams have closed, so no probe outlives the call. Given no env, spawn
// copies the whole parent env, which needs an unscoped env grant; the
// integration lane grants env by name. PATH is the one variable the probe
// resolves anything through (bash and the ps it runs), so it is the one
// forwarded.
function processIsAlive(pid: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const path = process.env.PATH;
    const child = spawn("bash", [
      "-c",
      'state=$(ps -o stat= -p "$1" 2>/dev/null) || exit 1; set -- $state; case "${1:-}" in ""|Z*) exit 1;; esac',
      "bash",
      String(pid),
    ], {
      env: path === undefined ? {} : { PATH: path },
      stdio: ["inherit", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code === 0));
  });
}

async function readPid(path: string): Promise<number> {
  const pid = Number(await readFile(path, "utf8"));
  assert.strictEqual(Number.isSafeInteger(pid) && pid > 0, true);
  return pid;
}

async function readMethods(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) =>
      line.length > 0
    );
  } catch (error) {
    if (
      (error instanceof Error &&
        (error as { code?: unknown }).code === "ENOENT")
    ) return [];
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
  it("two sequential turns reuse one worker and one ACP session", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await writeFile(methodLog, "");
      const profile = fixtureProfile({}, pidFile, methodLog);
      const map = new AcpSessionHandleMap({
        capacity: 2,
        idleTtlMs: 60_000,
      });
      try {
        const key = acquireKey(profile, "workbench-session-1");
        const first = await map.runTurn({ ...key, prompt: "first turn" });
        const pid = await readPid(pidFile);
        assert.strictEqual(first.stopReason, "stop");
        assert.ok(
          first.text.includes("first|"),
          `expected first.text to include "first|"`,
        );
        assert.strictEqual(await processIsAlive(pid), true);
        assert.deepStrictEqual(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
        ]);

        const second = await map.runTurn({ ...key, prompt: "second turn" });
        assert.strictEqual(second.stopReason, "stop");
        assert.ok(
          second.text.includes("first|"),
          `expected second.text to include "first|"`,
        );
        assert.strictEqual(await readPid(pidFile), pid);
        assert.strictEqual(await processIsAlive(pid), true);
        assert.deepStrictEqual(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
          "session/prompt",
        ]);
      } finally {
        await map.shutdown();
      }
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.strictEqual(await processIsAlive(pid), false);
      assert.deepStrictEqual(await readMethods(methodLog), [
        "initialize",
        "session/new",
        "session/prompt",
        "session/prompt",
        "session/close",
      ]);
    } finally {
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(methodLog).catch(() => {});
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
        assert.strictEqual(map.stateFor(acquireKey(profile)), undefined);
        assert.strictEqual(map.size, 0);
        const pid = await readPid(pidFile);
        assert.strictEqual(await processIsAlive(pid), false);
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
        assert.strictEqual(
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
      await removeTempPath(pidFile).catch(() => {});
    }
  });

  it("concurrent close callers receive the same result", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await writeFile(methodLog, "");
      const session = await startAcpSession({
        profile: fixtureProfile({}, pidFile, methodLog),
      });
      try {
        const first = session.close();
        assert.strictEqual(session.isAlive, false);
        const second = session.close();
        assert.strictEqual(second, first);
        assert.strictEqual(await first, undefined);
        assert.strictEqual(await second, undefined);
        assert.deepStrictEqual(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/close",
        ]);
      } finally {
        await session.close().catch(() => {});
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.strictEqual(await processIsAlive(pid), false);
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(methodLog).catch(() => {});
    }
  });

  it("logical closure immediately changes liveness", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await writeFile(methodLog, "");
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
        assert.strictEqual(session.isAlive, false);
        const second = session.close();
        assert.strictEqual(second, first);
        await assertRejectsWithFields(first, { phase: "terminate" });
        await assertRejectsWithFields(second, { phase: "terminate" });
        assert.deepStrictEqual(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/close",
        ]);
      } finally {
        await session.close().catch(() => {});
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.strictEqual(await processIsAlive(pid), false);
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(methodLog).catch(() => {});
    }
  });

  it("a pre-aborted turn finalizes as aborted without creating a handle", async () => {
    const pidFile = await tempPath();
    try {
      await unlink(pidFile);
      const map = new AcpSessionHandleMap({ capacity: 2, idleTtlMs: 60_000 });
      const controller = new AbortController();
      controller.abort();
      try {
        const result = await map.runTurn({
          ...acquireKey(fixtureProfile({}, pidFile)),
          prompt: "unused",
          abortSignal: controller.signal,
        });
        assert.strictEqual(result.stopReason, "aborted");
        assert.strictEqual(map.size, 0);
        await assert.rejects(
          () => stat(pidFile),
          (error: unknown) =>
            error instanceof Error &&
            (error as { code?: unknown }).code === "ENOENT",
        );
      } finally {
        await map.shutdown();
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
    }
  });

  it("cancellation during stalled creation finalizes as aborted and reaps the child", async () => {
    const pidFile = await tempPath();
    try {
      await unlink(pidFile);
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
            await stat(pidFile);
            break;
          } catch (error) {
            if (
              !(error instanceof Error &&
                (error as { code?: unknown }).code === "ENOENT")
            ) throw error;
            if (Date.now() >= deadline) {
              throw new Error("fixture did not start");
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        controller.abort();
        assert.partialDeepStrictEqual(await pending, { stopReason: "aborted" });
        assert.ok(Date.now() - startedAt < 1_000);
        assert.strictEqual(map.size, 0);
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.strictEqual(await processIsAlive(pid), false);
      } finally {
        await map.shutdown();
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
    }
  });
});

describe("startAcpSession", () => {
  it("cancellation during a prompt retains the live session", async () => {
    const pidFile = await tempPath();
    const methodLog = await tempPath();
    try {
      await writeFile(methodLog, "");
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
        assert.partialDeepStrictEqual(aborted, {
          text: "partial\n",
          stopReason: "aborted",
        });
        assert.strictEqual(session.isAlive, true);
        const pid = await readPid(pidFile);
        assert.strictEqual(await processIsAlive(pid), true);
        const next = await session.prompt({ prompt: "after cancel" });
        assert.strictEqual(next.stopReason, "stop");
        assert.deepStrictEqual(await readMethods(methodLog), [
          "initialize",
          "session/new",
          "session/prompt",
          "session/prompt",
        ]);
      } finally {
        await session.close();
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.strictEqual(await processIsAlive(pid), false);
      }
    } finally {
      await removeTempPath(pidFile).catch(() => {});
      await removeTempPath(methodLog).catch(() => {});
    }
  });
});
