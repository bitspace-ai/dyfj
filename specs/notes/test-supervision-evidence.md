# Test supervision after Vitest: evidence and decision

Status: evidence recorded; decision approved by the maintainer on 2026-09-29.
The end-of-run group stop in each test-lane runner (L12), saved-group recovery
in the gate (L13) and the runner's backstop deadline were approved on
2026-09-30. Written for WO-23 step 3 (`specs/work-orders.md`), under
`03-testing.md` §2.

## Question

The Vitest lanes run under a supervisor: `scripts/run-vitest.ts`,
`scripts/test-process-harness.ts` and `scripts/test-process-reaper.ts`, about
2.5k lines. It has four functions:

| Function             | What it does today                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lock**             | An operator-scoped lock (`$HOME/.dyfj/run/dyfj-vitest-run.lock`) refuses a second supervised run while a first is alive, across checkouts.                                                      |
| **Reaper**           | A detached sibling process that sweeps the run if the supervisor itself is SIGKILLed. The next run recovers a saved Vitest process group if both supervisor and reaper died.                    |
| **Manifest sweep**   | After the run, finds survivors from a spawn manifest, the run's temp dir and command needles (such as the ACP fixture agent's path). It TERM-then-KILLs them and fails the run if any survived. |
| **Wall-clock bound** | Fails the run after `DYFJ_TEST_BOUND_SEC` (600 s, or 180 s for a focused run) and tears it down.                                                                                                |

`03-testing.md` §2 carried a working thesis: per-test sanitizers plus
process-group spawning make most of this unnecessary once the suite runs on
`Deno.test`. Descendant (grandchild) processes are not covered by Deno's
sanitizers, so whatever guards against them must remain. This note tests that
thesis, one leak class at a time.

## What exists besides the supervisor

These mechanisms already exist outside the supervisor; the experiments show how
far they reach.

- **Deno sanitizers.** In the pinned Deno (2.9.6) they run only when asked
  (`--sanitize-ops --sanitize-resources`). `test.unit` passes both flags. The
  integration lane's `Deno.test` invocation does not yet.
- **Lane process groups in the aggregate gate**
  (`scripts/aggregate-test-gate.ts`). Every lane leader is its own process-group
  leader. When the leader exits, normally or not, the gate signals the whole
  group: TERM, then KILL after a 2 s grace. On interruption the budget is 10 s.
  The gate has no per-lane time limit; the CI job's 60-minute timeout is the
  only bound.
- **Self-terminating test helpers.** The ACP fixture agent
  (`scripts/acp-fixture-agent.ts`) and the process-group signal probe in
  `src/acp-client.ts` watch their parent pid every 200 ms. When the parent dies,
  they exit; the fixture agent first KILLs its own process group.
- **Per-run temp and ports.** Since the `Deno.test` migration, tests create temp
  files under the system temp dir, never the working tree. The integration lane
  gives each run its own temp, socket and MCP directories. The isolated Dolt
  fixture picks a free port and a fresh temp root.

## Method

Pinned Deno 2.9.6 on Linux (x86_64).

- **Synthetic leak cases:** small throwaway `Deno.test` files outside the
  repository, one per leak class, run with the same flags as `test.unit`, and
  with the integration grants where a class needs `--allow-run` or
  `--allow-net`.
- **Real-suite cases:** the migrated ACP and launcher integration files, run
  directly, interrupted with SIGKILL, and run concurrently.
- **Survivor counts:** taken with `ps` after the runner exited, excluding
  zombies. The build container used for these runs has a PID 1 that does not
  reap orphans, so killed orphans linger there as zombies. Zombies hold no
  resources, and CI runners reap them normally.

The synthetic cases are reproduced inline:

```ts
// L1 op leak                  (unit flags)
Deno.test("leaked timer", () => {
  setTimeout(() => {}, 5_000);
});
// L2 resource leak            (integration grants)
Deno.test("leaked file", async () => {
  await Deno.open(path);
});
Deno.test("leaked listener", () => {
  Deno.listen({ hostname: "127.0.0.1", port: 0 });
});
// L3 direct child not awaited (Deno.Command, node spawn, node spawn detached+unref)
Deno.test("child", () => {
  new Deno.Command("sleep", { args: ["30"] }).spawn();
});
// L4 grandchild via an awaited parent: same group, and setsid
await new Deno.Command("bash", { args: ["-c", "sleep 33 &"] }).output();
await new Deno.Command("bash", { args: ["-c", "setsid sleep 34 &"] }).output();
// L6 hang
await new Deno.Command("sleep", { args: ["100000"] }).spawn().status;
// L7 runner SIGKILLed mid-test with `sleep & sleep & setsid sleep &` running
// L10 a rejection that lands after its test resolved
new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 50));
```

## Results by leak class

| #   | Leak class                                                                                      | Observed on `Deno.test`                                                                                                                                                                                                                                                                                                                                                                                                                                    | Covered by                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Async op or timer outliving its test                                                            | With `--sanitize-ops`, the leaking test fails and is named ("A timer was started in this test, but never completed"). Without the flag, it passes silently.                                                                                                                                                                                                                                                                                                | Sanitizer, when enabled                                                                                                                                                                                                                                                                        |
| L2  | Resource (file, TCP listener, Unix connection, child stream) left open                          | With `--sanitize-resources`, the leaking test fails and is named. Without the flag, it passes.                                                                                                                                                                                                                                                                                                                                                             | Sanitizer, when enabled                                                                                                                                                                                                                                                                        |
| L3  | Direct child process not awaited or killed                                                      | With the sanitizer, the leaking test fails and is named, for `Deno.Command`, `node:child_process` `spawn`, and detached+unref spawns. After the runner exits, non-detached children are gone. A detached child survives (own group, reparented to init), with or without the flags.                                                                                                                                                                        | Sanitizer for detection. For detached children, only the child's own parent-death check (L5).                                                                                                                                                                                                  |
| L4  | Grandchild outliving its awaited parent                                                         | Passes with or without sanitizers. The same-group grandchild and the `setsid` grandchild both survive the runner.                                                                                                                                                                                                                                                                                                                                          | Same group: gate lane-group teardown (silent). `setsid`: nothing generic (see L5).                                                                                                                                                                                                             |
| L5  | Detached ACP fixture agent plus a TERM-ignoring grandchild, runner SIGKILLed mid-turn           | Real ACP client, hung turn (`FIXTURE_STUBBORN_DESCENDANT FIXTURE_MUTE`). Two live processes before the kill; both gone 0.5 s after it (0 at +0.5, +1 and +3 s). SIGKILLs of the full `acp-client.integration` file at 6, 10 and 14 s left 0 survivors.                                                                                                                                                                                                     | Fixture agent's parent-death check (KILLs its own group)                                                                                                                                                                                                                                       |
| L6  | Hang: a test awaits something that never settles                                                | Runs until an outside timeout kills it (25 s in the experiment). `Deno.test` has no per-test timeout and no lane has a time limit.                                                                                                                                                                                                                                                                                                                         | Nothing today except the supervisor's bound and the 60-minute CI job timeout                                                                                                                                                                                                                   |
| L7  | Runner SIGKILLed with same-group and `setsid` children                                          | The same-group children survive the runner. A TERM to the lane group (what the gate does after the leader exits) kills them. The `setsid` child survives both.                                                                                                                                                                                                                                                                                             | Gate lane-group teardown; nothing generic for `setsid`                                                                                                                                                                                                                                         |
| L8  | Two runs at once                                                                                | Measured on the combined revision, with every migration part merged. Two concurrent `test.unit` runs: 1253/1253 each. Two concurrent full isolated-Dolt integration lanes: identical results, 133 passed each, and no port or path collision. The one failure in each was the container-only zombie case described under Method. Neither run left files in the working tree.                                                                               | Per-run temp dirs, free ports, per-run socket dirs                                                                                                                                                                                                                                             |
| L9  | Launcher-started runtime (`nohup … start`)                                                      | Sampled every 250 ms through a full launcher-test run: every launcher-spawned process, the `nohup` autostart included, stays in the test runner's process group.                                                                                                                                                                                                                                                                                           | Gate lane-group teardown. In-test cleanup: the launcher tests' own process scan by socket path (`reapPidsAndCommandsContaining`).                                                                                                                                                              |
| L10 | Rejection landing after its test resolved (the historical "ACP connection closed" failure mode) | Fails loudly, attributed to the file ("Uncaught error from …", "This error was not caught from a test"). The remaining tests in that file are cancelled. With `--sanitize-ops`, the owning test fails first on its pending timer. The migrated ACP files ran 5× each under both sanitizers with no uncaught rejection.                                                                                                                                     | The `Deno.test` runner itself, plus the op sanitizer                                                                                                                                                                                                                                           |
| L11 | Fixture writes into the working tree (a historical debris failure mode)                         | `test.unit` grants writes only to the temp roots, so a write into the tree fails the test with a permission error. The migrated integration files use the system temp dir. The integration invocation grants writes only to its per-run directories and temp roots.                                                                                                                                                                                        | Lane write grants                                                                                                                                                                                                                                                                              |
| L12 | The aggregate gate itself SIGKILLed while a lane runs                                           | A stand-in for the gate spawned a `deno test` lane detached, as the gate spawns lanes, and was SIGKILLed 1.5 s in. The lane kept running and exited normally. Its test had left a same-group `sleep` grandchild, which survived the lane (reparented to init). The gate's teardown never ran.                                                                                                                                                              | Today, the Vitest supervisor: it runs Vitest in a process group of its own and, in its `finally`, TERM-then-KILLs that whole group, so it removes such a grandchild even when the gate is dead. After the removal, each test-lane runner takes over that end-of-run group stop (see Decision). |
| L13 | The aggregate gate and the lane runner both SIGKILLed while a test runs                         | A stand-in gate spawned a runner detached; the runner started `deno test` in its own group, as the unit and integration runners do. The test started a same-group `sleep` through `bash` and then ran 8 s. Both the gate and the runner were SIGKILLed 3 s in. `deno test` was re-parented to init, finished its test and exited; the `sleep` grandchild outlived it in the orphaned group. A hung test would have kept `deno test` running with no bound. | Today, the Vitest supervisor's saved-group recovery: the next run stops a group recorded by a run whose supervisor and reaper both died. After the removal, the gate's saved-group recovery covers it (see Decision).                                                                          |

### What turning on sanitizers across the integration lane would surface today

A run of every `Deno.test` integration file with both sanitizers found these
leaks. (Corrected 2026-09-30: an earlier version of this note called all of them
test-side and listed four files. The Unix-connection leaks were in product code,
and the secrets-resolver case was missed.)

- `src/transport/uds-listener.integration.test.ts` (two cases) and
  `src/cli/commands/stop.integration.test.ts`: a Unix connection left open. This
  was a product leak, not a test one: the runtime's Unix-socket server never
  closed its side of a connection after the client disconnected. It is fixed in
  product code as its own change, with a CHANGELOG `Security` entry; these cases
  now pass under both sanitizers.
- `scripts/memory-recall-uat-fixture.integration.test.ts`: leaves a child's
  stdout and stderr open. Test-side.
- `scripts/isolated-dolt-fixture.integration.test.ts`: two timers are left
  pending by the fixture helper's shutdown timeout. Test tooling.
- `src/secrets.integration.test.ts`: the resolver-timeout case leaves an output
  read pending. This is by design: on timeout the resolver stops awaiting a
  stuck child's output so it can never hold the boot, and the case's `sleep`
  grandchild keeps the pipes open for about 5 s. When the lane turns sanitizers
  on, that case runs with both off and a comment saying why.

The ACP client, session-map, external-agent-runtime, launcher, launch-grant,
repo-context and `deno.json` task integration files already pass under both
sanitizers.

## Decision

| Function             | Decision                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lock**             | **Remove**                                                                        | The lock stopped concurrent Vitest runs from sharing state: the harness temp dir (`.vitest-tmp`), temp files created in the working tree, and the operator lock itself. None of that shared state exists on `Deno.test`. L8 shows two unit lanes and two full integration lanes of the combined migrated suite running at once with identical, correct results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Reaper**           | **Remove the detached reaper; keep saved-group recovery, in the gate**            | It covered a SIGKILLed supervisor leaving the run's processes alive. On `Deno.test`: same-group descendants are killed by the gate's lane-group teardown (L7, L9). The detached processes the suite starts (the ACP fixture agent and the signal probe) end themselves within 0.5 s of their parent's death (L5). Next-run recovery of a saved group covers the one case those do not: the runner killed together with the gate (L13). `03-testing.md` §2 requires that whatever guards against descendant processes remains, so it stays, with the gate in the supervisor's place (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Manifest sweep**   | **Remove, and enable both sanitizers on the integration lane in the same change** | The sweep's job was to detect leaked processes and fail the run. The sanitizers do that per test, attribute the leak to the test that caused it, and also cover ops, timers, handles and sockets, which the sweep never did (L1–L3). The test-side leaks above are fixed in that change; the product leak was fixed on its own first. Grandchildren are not covered by the sanitizers (L4). They are covered by lane-group teardown for same-group processes, and by the parent-death check for the only detached processes the suite starts. The sweep's production hook goes with it: `src/acp-client.ts` appends `DYFJ_TEST_RUN_DIR` to the signal probe's arguments only so the sweep's command-needle search can find it, and `testRunDir` has a config-schema entry. Removing the hook changes an internal probe's argv, nothing observable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Wall-clock bound** | **Retain, as a per-lane deadline in the aggregate gate, with a runner backstop**  | L6 is the one class nothing else covers. A hang runs until the CI job's 60-minute timeout, fails with no lane named, and blocks every other lane's result. The bound moves from the Vitest supervisor into `scripts/aggregate-test-gate.ts`, which already owns each lane's process group. When a lane passes its deadline, the gate uses the teardown it already runs on interruption: TERM to the lane group, the remaining budget, then KILL to the leader and the group. The lane is reported as failed with a message naming it and the bound. No process is moved into a new group, so the gate still reaches every same-group descendant. A bound inside a lane's own runner would have to kill `deno test` by process group. That puts `deno test` in a group of its own, which the gate's lane-group teardown cannot reach if the runner is SIGKILLed: the gap the reaper covered (L7). The runner's backstop (see below) avoids that by killing `deno test` by pid, not by group. The lanes that get a deadline, with defaults from measured run times: `test.unit` 120 s (12–22 s locally), the isolated-Dolt integration lane 900 s (about 95–120 s) and the golden lane 900 s. `DYFJ_TEST_BOUND_SEC` stays as the override. The change that applies this adds a gate orchestration test: a lane that exceeds its deadline while holding a same-group descendant fails, and leaves no survivor. A run outside the gate, such as a direct `deno task test:unit`, has no bound. |

What moves rather than goes:

- `reapPidsAndCommandsContaining`, the process scan the launcher integration
  tests use to clean up a runtime they started (L9), moves from
  `scripts/test-process-harness.ts` into shared test support under `testing/`.
- The Vitest supervisor's end-of-run group stop moves into each test-lane
  runner: the unit, isolated-Dolt integration and golden runners. When all of
  its work is done, the runner sends TERM to its own process group, handling
  that TERM itself so it survives to report its result. "Done" means every child
  the runner starts has exited and its own cleanup has run, not merely that
  `deno test` has exited: the integration runner goes on to run the Cargo schema
  round-trip against the same Dolt fixture, whose server is a same-group child,
  and stops that server in its own cleanup. This keeps L12 covered: if the gate
  is SIGKILLed, the lane still finishes and still removes its same-group
  grandchildren. It changes no process's group, so the gate's lane-group
  teardown and deadline still reach everything. Two conditions make it safe:
  - The runner has to be its lane group's leader, so the unit lane is started as
    its runner directly rather than through `deno task`, whose process would
    otherwise take the TERM and fail the lane.
  - The runner stops its group only when the gate started it as a lane, which
    the gate marks in the lane's environment. A direct run shares the invoking
    shell's process group, and signalling that group would reach the shell's
    other processes.

  The change that applies this adds a gate orchestration test: a lane whose test
  leaves a same-group grandchild, run with the gate SIGKILLed partway through,
  leaves no survivor once the lane finishes.

- Each test-lane runner also carries a backstop deadline: the lane's bound plus
  60 s. It matters only when the gate is gone (L12 during an L6 hang), because
  with the gate alive the gate's deadline fires first. When it expires, the
  runner sends KILL by pid to the child it is waiting on (`deno test`, or the
  integration runner's Cargo step), runs its own cleanup, then stops its own
  group as at the end of a run, and exits failing with a message that names the
  backstop. Killing by pid keeps every child in the lane group, so the gate's
  teardown still reaches it. The change that applies this adds a gate
  orchestration test: with the gate SIGKILLed during a hang, the lane ends at
  the backstop and leaves no survivor.
- The Vitest supervisor's saved-group recovery moves into the gate, for the case
  where the gate and the runner are both SIGKILLed (L13):
  - When a test-lane runner starts `deno test`, it writes a record naming its
    lane, its group id and the child's pid, start time and command. The record
    goes where the gate says in the lane's environment: an operator-scoped place
    under HOME, as the Vitest lock was. It also names the gate process by pid
    and start time. The gate removes the record when the lane ends.
  - At its next start, the gate reads each record left behind whose gate is no
    longer running, so a concurrent gate's live lanes are never touched. If the
    recorded `deno test` is still alive with the same start time and command,
    and is still a member of the recorded process group, the gate sends TERM to
    the group, waits, then sends KILL. Otherwise it leaves the numeric group
    alone and drops the record, so a reused process or group id is never
    signalled. The membership check matters because a child that left the group
    would leave the numeric group id free for an unrelated group to reuse. This
    is the Vitest supervisor's recovery rule, with the gate in the supervisor's
    place.
  - The change that applies this adds a gate orchestration test: with the gate
    and the runner both SIGKILLed during a hang, the next gate run stops the
    orphaned `deno test` and its same-group grandchild. A record whose process
    identity no longer matches is dropped without a signal.

## Residual risk accepted

- **Silent grandchild cleanup.** A grandchild in the lane's process group is
  killed at lane end but not reported (L4 and L7). One known case: the
  secret-resolver timeout test leaves a `sleep` for about 5 s after its resolver
  is killed.
- **A new detached helper without a parent-death check.** A future test helper
  that starts a detached process and has no parent-death check would outlive a
  SIGKILLed runner (L3, L4 `setsid`). The ACP fixture agent is the pattern to
  follow. Nothing in the suite does this today.
- **A TERM-ignoring grandchild after a SIGKILLed gate.** The test-lane runner's
  end-of-run group stop (see Decision) sends TERM only: the runner cannot send
  KILL to its own group without killing itself. A same-group grandchild that
  ignores TERM therefore outlives a lane whose gate was SIGKILLed (L12). With
  the gate alive, its lane-group teardown still sends KILL. No test in the suite
  leaves such a process today. The Vitest supervisor, which ran Vitest in a
  group it did not belong to, could send KILL as well.
- **Between a double crash and the next gate run.** With the gate and the runner
  both SIGKILLed (L13), the orphaned group runs until the next gate run recovers
  it; a hung test runs that long. If `deno test` has already exited by then,
  what is left in the group is not recovered, because nothing still proves the
  group is the lane's: a grandchild `deno test` left, or, for the integration
  runner killed during its Cargo step, the Dolt server and Cargo. The Vitest
  supervisor's recovery had the same limit. A local Ctrl-C never leaves this
  state: it reaches the gate, whose interruption teardown stops every lane
  group. In CI the hosted runner is discarded when the job ends.
- **Runs outside the gate.** A direct `deno test` run, not through the gate, has
  neither lane-group teardown, the wall-clock bound nor the runner's end-of-run
  group stop. A same-group grandchild survives both a normal exit of the runner
  (L4) and a SIGKILL of it (L7). Ctrl-C reaches it, because it signals the whole
  foreground group. Of today's tests, only the secret-resolver timeout case
  leaves one, and only for about 5 s.
