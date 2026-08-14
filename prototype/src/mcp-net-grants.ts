import type { McpHttpServerConfig } from "./config.ts";

// Keep launch authority derivation dependency-light: the thin CLI must not
// import the external-tool runtime and its engine dependencies.
export function mcpServerNetGrants(
  servers: readonly McpHttpServerConfig[],
): string[] {
  const grants: string[] = [];
  for (const server of servers) {
    const url = new URL(server.url);
    const port = url.port === ""
      ? url.protocol === "http:" ? "80" : "443"
      : url.port;
    const grant = `${url.hostname}:${port}`;
    if (!grants.includes(grant)) grants.push(grant);
  }
  return grants;
}
