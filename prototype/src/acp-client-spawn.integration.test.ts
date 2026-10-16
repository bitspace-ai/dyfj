import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import {
  assertProcessGroupSignaler,
  runAcpAgent,
  runSignalCommand,
} from "./acp-client.ts";
import { composeRuntimePolicy, type RuntimePolicy } from "./config/mod.ts";
import { fixtureProfile } from "./external-agent-runtime.ts";

const posix = process.platform !== "win32";

function withRun(run: string[]): RuntimePolicy {
  return { ...composeRuntimePolicy(), run };
}

describe("ACP runner spawn policy", { skip: !posix }, () => {
  it("the signaler refuses /bin/kill when the policy does not hold it", async () => {
    await assert.rejects(
      runSignalCommand(
        ["-0", "--", String(process.pid)],
        2_000,
        "/bin/kill",
        withRun(["/bin/sleep"]),
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "AcpRunnerError" &&
        /spawn of "\/bin\/kill" refused/.test(error.message),
    );
  });

  it("the process-group probe refuses /bin/sleep when the policy does not hold it", async () => {
    await assert.rejects(
      assertProcessGroupSignaler(
        "/bin/kill",
        2_000,
        ["/bin/sleep", "30"],
        withRun(["/bin/kill"]),
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "AcpRunnerError" &&
        /spawn of "\/bin\/sleep" refused/.test(error.message),
    );
  });

  it("the probe passes under the base policy", async () => {
    await assertProcessGroupSignaler(
      "/bin/kill",
      2_000,
      ["/bin/sleep", "30"],
      composeRuntimePolicy(),
    );
  });

  it("the agent spawn refuses a command outside the policy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dyfj-acp-spawn-"));
    try {
      await assert.rejects(
        runAcpAgent({
          profile: {
            ...fixtureProfile(workspace),
            command: "/usr/bin/true",
            args: [],
          },
          prompt: "hello",
          runPolicy: composeRuntimePolicy(),
        }),
        (error: unknown) =>
          error instanceof Error && error.name === "AcpRunnerError" &&
          /spawn of "\/usr\/bin\/true" refused/.test(error.message),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
