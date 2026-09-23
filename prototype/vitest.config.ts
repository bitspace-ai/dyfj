import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  server: {
    fs: {
      strict: true,
      allow: ["."],
    },
  },
  test: {
    // Sized from what this suite costs, rather than left at Vitest's
    // defaults of 5s per test and 10s per hook. The measurements, the four
    // observed failures and the full-run results are recorded in
    // `VERIFICATION-2026-09-22.md` beside this file, with the method to
    // re-measure them.
    //
    // Measured on an idle machine with every test passing: the slowest single
    // test is 3.65s and the five next-slowest all exceed 2.3s, so the 5s
    // default left roughly 1.4x headroom over the slowest thing it had to
    // admit. The hook
    // figure comes from an observed failure rather than a margin — the
    // `afterEach` in `scripts/test-process-harness.test.ts`, which drains
    // spawned children, reported `Hook timed out in 10000ms` under the full
    // run.
    //
    // What the evidence supports: four files were seen failing this way in one
    // afternoon — `scripts/test-process-harness.test.ts` on the hook timeout,
    // `src/acp-client.test.ts` on the test timeout, and
    // `src/external-agent-runtime.test.ts` and `src/acp-session-map.test.ts`
    // on late timers during initialize. Every one was a timeout rather than a
    // failed assertion, every one was green when the file ran on its own, and
    // three consecutive full runs passed at 2192/2192 after this change.
    //
    // What it does not establish is the cause. The failures happened under the
    // parallel run and did not reproduce when those files ran individually.
    // That is a correlation, and these settings do not explain it. If these
    // files start failing again, the cause is still open and that is where to
    // look.
    //
    // The cost is that a test or hook which stays pending is reported later:
    // it can now run to 30s, or 45s for a hook, before the suite says so.
    // These are thresholds, not cancellation and not a required duration —
    // work that finishes sooner still finishes sooner, and a timed-out
    // teardown that left a child holding a resource still leaves it.
    //
    // The supervised Vitest phase under `deno task test` has its own
    // deadline, defaulting to 600s (180s for a recognised focused run) and
    // overridable, with cleanup following it; a direct Vitest invocation has
    // no such bound.
    testTimeout: 30_000,
    hookTimeout: 45_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
