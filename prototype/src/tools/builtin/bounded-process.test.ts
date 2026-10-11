import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  createGroupStopper,
  describeTimeout,
  groupSignalArgs,
  type SignalOutcome,
  type SignalRunner,
} from "./bounded-process.ts";

describe("groupSignalArgs", () => {
  it("refuses a group id that would signal more than one group", () => {
    for (const group of [0, 1, -5, 2.5, Number.NaN, 2 ** 60]) {
      assertThrows(() => groupSignalArgs(group, "TERM"), RangeError);
    }
  });

  it("names the negated group id after the end-of-options marker", () => {
    assertEquals(groupSignalArgs(4242, "TERM"), ["-s", "TERM", "--", "-4242"]);
    assertEquals(groupSignalArgs(4242, "KILL"), ["-s", "KILL", "--", "-4242"]);
    assertEquals(groupSignalArgs(4242, "0"), ["-0", "--", "-4242"]);
  });
});

// A scripted /bin/kill: each call is recorded as its signal ("TERM", "KILL",
// or "0" for the liveness probe) and answered from the queue for that signal;
// a signal with an empty queue repeats its last answer.
function scripted(answers: Record<string, SignalOutcome[]>) {
  const calls: string[] = [];
  const run: SignalRunner = (args) => {
    const signal = args[0] === "-0" ? "0" : args[1];
    calls.push(signal);
    const queue = answers[signal] ?? [];
    const outcome = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(outcome ?? "failed");
  };
  return { run, calls };
}

describe("createGroupStopper", () => {
  it("stops after TERM alone when the group empties within the grace", async () => {
    const kill = scripted({ TERM: ["delivered"], "0": ["delivered", "gone"] });
    const stop = createGroupStopper(kill.run);
    assertStrictEquals(await stop(4242, 500), "stopped");
    assertEquals(kill.calls, ["TERM", "0", "0"]);
  });

  it("reports a group that was already gone without waiting", async () => {
    const kill = scripted({ TERM: ["gone"] });
    assertStrictEquals(
      await createGroupStopper(kill.run)(4242, 500),
      "stopped",
    );
    assertEquals(kill.calls, ["TERM"]);
  });

  it("escalates to KILL when the group ignores TERM through the grace", async () => {
    const kill = scripted({
      TERM: ["delivered"],
      KILL: ["delivered"],
      // Live through the grace, then gone once KILL has landed.
      "0": ["delivered", "delivered", "delivered", "delivered", "gone"],
    });
    const result = await createGroupStopper(kill.run, {
      pollMs: 10,
      killSettleMs: 200,
    })(4242, 15);
    assertStrictEquals(result, "stopped");
    const kill_at = kill.calls.indexOf("KILL");
    assertEquals(kill.calls[0], "TERM");
    assertEquals(kill_at > 1, true, kill.calls.join(" "));
    assertEquals(kill.calls.slice(0, kill_at).includes("0"), true);
    assertEquals(kill.calls.slice(kill_at + 1).includes("0"), true);
  });

  it("reports a survivor when the group is still live after KILL and its settle bound", async () => {
    const kill = scripted({
      TERM: ["delivered"],
      KILL: ["delivered"],
      "0": ["delivered"],
    });
    const result = await createGroupStopper(kill.run, {
      pollMs: 5,
      killSettleMs: 40,
    })(4242, 10);
    assertStrictEquals(result, "survived");
  });

  it("treats a failed probe as live, never as stopped", async () => {
    const kill = scripted({
      TERM: ["delivered"],
      KILL: ["delivered"],
      "0": ["failed"],
    });
    const result = await createGroupStopper(kill.run, {
      pollMs: 5,
      killSettleMs: 30,
    })(4242, 10);
    assertStrictEquals(result, "survived");
  });

  it("is unavailable when /bin/kill cannot run, and signals nothing more", async () => {
    const kill = scripted({ TERM: ["unavailable"] });
    assertStrictEquals(
      await createGroupStopper(kill.run)(4242, 500),
      "unavailable",
    );
    assertEquals(kill.calls, ["TERM"]);
  });

  it("is unavailable for a group id it must not signal, without spawning", async () => {
    const kill = scripted({});
    const stop = createGroupStopper(kill.run);
    for (const group of [0, 1, -3, 2.5]) {
      assertStrictEquals(await stop(group, 500), "unavailable");
    }
    assertEquals(kill.calls, []);
  });
});

describe("describeTimeout", () => {
  it("reads as a plain kill when the runner gave no termination detail", () => {
    assertStringIncludes(describeTimeout(10), "timed out after 10ms (killed)");
  });

  it("says when the command's exit status is unavailable", () => {
    assertStringIncludes(
      describeTimeout(10, {
        group: "survived",
        exited: false,
        outputClosed: false,
      }),
      "the command itself had not exited after SIGKILL, so its exit status is unavailable",
    );
  });
});
