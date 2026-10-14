// The comparison behind the per-file Node handle check
// (`node-handle-check.ts`), kept apart from it so it can be tested without
// preloading the check into the test that tests it.

/**
 * The resource types live in `now` beyond `baseline`, compared as multisets
 * and sorted. A type may be live at load for reasons outside the file, such
 * as the test runner's own IPC pipes, so only the count above the baseline
 * is a leak: two `PipeWrap`s at load and three at the end leak one.
 */
export function leakedResources(
  baseline: readonly string[],
  now: readonly string[],
): string[] {
  const remaining = new Map<string, number>();
  for (const type of baseline) {
    remaining.set(type, (remaining.get(type) ?? 0) + 1);
  }
  const leaked: string[] = [];
  for (const type of now) {
    const left = remaining.get(type) ?? 0;
    if (left > 0) remaining.set(type, left - 1);
    else leaked.push(type);
  }
  return leaked.sort();
}

/** The check's report for a file that leaked. */
export function leakReport(file: string, leaked: readonly string[]): string {
  return `dyfj node handle check: ${file} left ${leaked.length} resource(s) ` +
    `live after its tests: ${leaked.join(", ")}. Close every server, ` +
    "socket, timer and child process a test starts before it ends.";
}
