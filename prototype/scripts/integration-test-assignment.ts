export const integrationTestAssignments = {
  vitest: [],
  deno: [
    "src/acp-client.integration.test.ts",
    "src/acp-runner.integration.test.ts",
    "src/acp-session-map.integration.test.ts",
    "src/cli/commands/status.integration.test.ts",
    "src/cli/launcher/grants.integration.test.ts",
    "src/cli/commands/stop.integration.test.ts",
    "src/cli/turn-client.integration.test.ts",
    "src/config/env.integration.test.ts",
    "src/context/repo-context.integration.test.ts",
    "src/engine/build-context.integration.test.ts",
    "src/external-agent-runtime.integration.test.ts",
    "src/mcp-conformance.integration.test.ts",
    "src/mcp-tools.integration.test.ts",
    "src/memory.integration.test.ts",
    "src/memory-search.integration.test.ts",
    "src/providers/http.integration.test.ts",
    "src/secrets.integration.test.ts",
    "src/server/console-canary.integration.test.ts",
    "src/server/events-asof.integration.test.ts",
    "src/server/main.integration.test.ts",
    "src/store/dolt-store.integration.test.ts",
    "src/tools/builtin/memory.integration.test.ts",
    "src/tools/web/dns.integration.test.ts",
    "scripts/deno-tasks.integration.test.ts",
    "scripts/dyfj-launcher.integration.test.ts",
    "scripts/isolated-dolt-fixture.integration.test.ts",
    "scripts/memory-recall-uat-fixture.integration.test.ts",
    "scripts/test-files.integration.test.ts",
    "src/transport/jsonrpc-peer.integration.test.ts",
    "src/transport/uds-client.integration.test.ts",
    "src/transport/uds-listener.integration.test.ts",
  ],
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
