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

const INVALID_DOLT_PORT_DIAGNOSTIC =
  "invalid DOLT_PORT: must be a decimal integer between 1 and 65535";

/**
 * Validate DOLT_PORT before it enters any Deno network grant.
 *
 * Accepts:
 *  - undefined, null, or omitted: defaults to 3306.
 *  - a non-empty string composed strictly of 1 to 5 decimal digits (1-65535).
 *  - a safe integer number in the range 1-65535.
 *
 * Rejects:
 *  - non-decimal characters, delimiters (commas, colons, slashes), signs (+, -),
 *    whitespace (leading/trailing/internal), floats, zero, >65535, empty strings,
 *    non-null objects, booleans, and other non-port types.
 *
 * Rejection diagnostics are strictly fixed and credential-free (never echoing the input).
 */
export function validateDoltPort(rawPort?: unknown): number {
  if (rawPort === undefined || rawPort === null) {
    return 3306;
  }
  let portNumber: number;
  if (typeof rawPort === "string") {
    if (rawPort.length === 0 || rawPort.length > 5 || !/^[0-9]+$/.test(rawPort)) {
      throw new Error(INVALID_DOLT_PORT_DIAGNOSTIC);
    }
    portNumber = Number(rawPort);
  } else if (typeof rawPort === "number") {
    portNumber = rawPort;
  } else {
    throw new Error(INVALID_DOLT_PORT_DIAGNOSTIC);
  }

  if (
    !Number.isSafeInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    throw new Error(INVALID_DOLT_PORT_DIAGNOSTIC);
  }
  return portNumber;
}

/**
 * Build the exact loopback --allow-net Deno grant for the Dolt MCP server child.
 */
export function buildDoltAllowNetGrant(rawPort?: unknown): string {
  const port = validateDoltPort(rawPort);
  return `--allow-net=127.0.0.1:${port}`;
}
