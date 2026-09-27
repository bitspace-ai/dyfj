/** Identifier generation for events, sessions, and trace context. */
import { ulid } from "ulid";

/** A new ULID: 26 Crockford Base32 characters, time-ordered. */
export function generateULID(): string {
  return ulid();
}

/** A W3C trace-context-compatible trace ID: 32 lowercase hex characters. */
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
}

/** A span ID: 16 lowercase hex characters. */
export function generateSpanId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
