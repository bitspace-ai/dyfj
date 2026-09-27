# Vitest timeout sizing — measurements, 2026-09-22

Figures behind `testTimeout` and `hookTimeout` in `vitest.config.ts`.

A timeout written as a plain number reads as a considered choice and usually
is not. This file records how the two values were arrived at, so a later reader
can re-measure against the same method rather than guess whether they were ever
right. It does not argue that these are the correct values forever; it records
what the suite cost on the day they were chosen.

## Method

Durations come from Vitest's own JSON reporter over the same suite the default
task runs:

```sh
cd prototype
deno task test:file --reporter=json --outputFile=<path> \
  --exclude '**/*.integration.{test,spec}.?(c|m)[jt]s?(x)'
```

Per-test durations are `assertionResults[].duration`; the file totals below are
the sum of those durations per file, not wall-clock for the file, which
includes transform and collection the reporter accounts for separately.

Measured on an otherwise idle developer machine. These are not CI numbers, and
a loaded machine will be slower — which is the situation the values exist for.

## Per-test durations

Slowest individual tests, against Vitest's 5000ms default `testTimeout`:

| ms | file | test |
| --- | --- | --- |
| 3654 | `scripts/dyfj-launcher.test.ts` | rejects whole dot components before resolving toolchain directories |
| 3103 | `src/cli-stop.test.ts` | reports failure via io.err and returns 1 when runtime does not close |
| 3051 | `scripts/test-process-harness.test.ts` | a hung recorded child fails the reaper bound instead of surviving |
| 2858 | `scripts/test-process-harness.test.ts` | force-killing a supervisor-shaped process reaps a detached launcher |
| 2375 | `scripts/test-process-harness.test.ts` | matching Vitest group identity is reaped on stale-lock recovery |
| 2354 | `src/acp-client.test.ts` | keeps the deadline paused until overlapping confirmations settle |

The slowest test sits at roughly 1.4x inside the 5000ms default.

## Per-file totals

Summed test durations, for context on the hook budget:

| ms | file |
| --- | --- |
| 28217 | `scripts/test-process-harness.test.ts` |
| 25544 | `src/file-tools.test.ts` |
| 20648 | `src/acp-client.test.ts` |
| 11691 | `scripts/dyfj-launcher.test.ts` |
| 8849 | `src/external-agent-runtime.test.ts` |

These totals are context, not a hook measurement: `hookTimeout` bounds a single
hook invocation, not a file. The hook value comes from an observed failure
instead — the `afterEach` in `scripts/test-process-harness.test.ts`, which
drains spawned children, reported `Hook timed out in 10000ms` under the full
parallel run.

## Observed failures

Four files were seen failing under the full parallel run within one afternoon,
each on a timeout rather than a failed assertion, and each green when the file
ran on its own:

| file | reported limit |
| --- | --- |
| `scripts/test-process-harness.test.ts` | `Hook timed out in 10000ms` |
| `src/acp-client.test.ts` | `Test timed out in 5000ms` |
| `src/external-agent-runtime.test.ts` | late timer during initialize |
| `src/acp-session-map.test.ts` | late timer during initialize |

This set is not the same as the slow tests measured above.

## Full-run results after the change

Three consecutive `deno task test` runs with `testTimeout: 30_000` and
`hookTimeout: 45_000`, each exiting 0 with no reported error blocks, and a
fourth captured in full:

```
Test Files  48 passed (48)
Tests  2192 passed (2192)
Duration  28.95s
```

The suite is 2192 tests across 48 files at the time of measurement.

## What this does not establish

That the timeouts were the cause. The failures happened under the parallel run
and did not reproduce individually; that is a correlation, and these settings
do not explain it. Re-measure before treating these numbers as current.
