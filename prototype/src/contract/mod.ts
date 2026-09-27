/**
 * contract/ — layer L1: the runtime contract shared by the engine, its
 * runners, the server, and every client.
 *
 * Responsibility: turn request and result types, the stream-frame union,
 * receipt types, history-omission notices, runtime input/event/auth types,
 * `DomainError`, the `Runner` interface, and the trust-boundary policy that
 * decides what crosses the wire (`summarizeError`, `workspaceRootForTransport`).
 * No I/O. Wire types stay plain data (JSON-serializable, no functions or class
 * instances), so a client in any language can speak them.
 *
 * Allowed dependencies: kernel/ and the platform. Nothing from any other
 * runtime layer (specs/01-architecture.md §3); the arch.imports lane enforces
 * the direction.
 */
export type { Runner } from "./runner.ts";
export * from "./runtime.ts";
export * from "./turn.ts";
