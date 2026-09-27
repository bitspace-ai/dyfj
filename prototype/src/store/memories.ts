/**
 * Memory privacy scoping: the one place the clearance rule lives. Readers take
 * a clearance (the visibility classes the consumer may receive) and filter by
 * it; both the runtime and the memory MCP server compute that clearance here.
 *
 * `MemoryVisibility` is the privacy class of a row (AGENTS.md taxonomy),
 * generated from the `memories.visibility` column; it governs which consumers
 * receive the row at injection time.
 */

import type { MemoryVisibility } from "./generated/rows.ts";

/** Full clearance: a local operator sees every class. */
export const MEMORY_VISIBILITY_ALL: readonly MemoryVisibility[] = [
  "private",
  "shareable",
  "client_safe",
  "public",
];

/**
 * Visibility classes a consumer is cleared to receive, by transport. The
 * loopback/in-process operator at the machine sees everything; any
 * non-loopback consumer — remote or shared, even with the bearer key, since the
 * shared bearer does not prove identity — is limited to client-safe + public
 * until per-principal identity exists. Safe by default: an
 * unrecognised transport gets the most restrictive set.
 */
export function memoryClearanceFor(
  transport: "loopback" | "remote",
): MemoryVisibility[] {
  return transport === "loopback"
    ? [...MEMORY_VISIBILITY_ALL]
    : ["client_safe", "public"];
}

/**
 * A standalone stdio MCP connection has no authenticated principal. Until it
 * does, it receives the same conservative clearance as every remote consumer.
 */
export const MCP_STDIO_MEMORY_CLEARANCE: readonly MemoryVisibility[] =
  memoryClearanceFor("remote");
