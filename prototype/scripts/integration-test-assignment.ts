export const integrationTestAssignments = {
  vitest: [
    "scripts/isolated-dolt-fixture.integration.test.ts",
    "src/memory.integration.test.ts",
    "src/uds-canary.integration.test.ts",
  ],
  deno: ["src/mcp-roundtrip.integration.test.ts"],
} as const;

export function assignedIntegrationTests(): string[] {
  return [
    ...integrationTestAssignments.vitest,
    ...integrationTestAssignments.deno,
  ].sort();
}

export function assertIntegrationTestAssignments(
  discovered: string[],
  assigned = assignedIntegrationTests(),
): void {
  const integrationTests = discovered.filter((path) =>
    /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  ).sort();
  const missing = integrationTests.filter((path) => !assigned.includes(path));
  const stale = assigned.filter((path) => !integrationTests.includes(path));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `integration test assignment mismatch: missing=${
        missing.join(",") || "none"
      }; stale=${stale.join(",") || "none"}`,
    );
  }
}
