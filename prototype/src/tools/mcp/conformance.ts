/** Reusable MCP 2026-07-28 conformance boundaries owned by Workbench. */

export type McpSpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

export interface McpTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
}

export interface ExtractedMcpTraceContext {
  traceId: string;
  parentSpanId: string;
  traceFlags: number;
  traceState?: string;
  parentIsRemote: true;
}

export type McpMeta = Record<string, unknown>;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_STATE_MAX_BYTES = 512;
const TRACE_STATE_MAX_MEMBERS = 32;
const SIMPLE_TRACE_STATE_KEY = /^[a-z][_0-9a-z*\-/]{0,255}$/;
const MULTI_TENANT_TRACE_STATE_KEY =
  /^[a-z0-9][_0-9a-z*\-/]{0,240}@[a-z][_0-9a-z*\-/]{0,13}$/;

function isAllZero(value: string): boolean {
  return !/[^0]/.test(value);
}

function validTraceId(value: string): boolean {
  return TRACE_ID.test(value) && !isAllZero(value);
}

function validSpanId(value: string): boolean {
  return SPAN_ID.test(value) && !isAllZero(value);
}

/**
 * Validate and normalize W3C tracestate. Invalid optional state is dropped;
 * it never invalidates an otherwise usable canonical parent relationship. A
 * single invalid member drops the whole value instead of retaining a subset
 * whose changed member set could alter vendor semantics.
 */
export function normalizeTraceState(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (new TextEncoder().encode(value).byteLength > TRACE_STATE_MAX_BYTES) {
    return undefined;
  }
  const rawMembers = value.split(",");
  if (rawMembers.length === 0 || rawMembers.length > TRACE_STATE_MAX_MEMBERS) {
    return undefined;
  }
  const seen = new Set<string>();
  const members: string[] = [];
  for (const rawMember of rawMembers) {
    const member = rawMember.trim();
    const equals = member.indexOf("=");
    if (equals <= 0 || equals !== member.lastIndexOf("=")) return undefined;
    const key = member.slice(0, equals);
    const memberValue = member.slice(equals + 1);
    if (
      (!SIMPLE_TRACE_STATE_KEY.test(key) &&
        !MULTI_TENANT_TRACE_STATE_KEY.test(key)) ||
      seen.has(key) || memberValue.length === 0 ||
      memberValue.startsWith(" ") || memberValue.endsWith(" ")
    ) return undefined;
    for (const character of memberValue) {
      const code = character.charCodeAt(0);
      if (code < 0x20 || code > 0x7e || character === "," || character === "=") {
        return undefined;
      }
    }
    seen.add(key);
    members.push(`${key}=${memberValue}`);
  }
  return members.join(",");
}

/**
 * Attach validated W3C context using Workbench's existing canonical trace and
 * span identifiers. Raw baggage is always removed at this boundary.
 */
export function injectMcpTraceContext(
  meta: McpMeta | undefined,
  context: McpTraceContext,
): McpMeta {
  if (!validTraceId(context.traceId) || !validSpanId(context.spanId)) {
    throw new Error("MCP trace context requires canonical lowercase non-zero identifiers");
  }
  if (!Number.isInteger(context.traceFlags) || context.traceFlags < 0 || context.traceFlags > 0xff) {
    throw new Error("MCP trace flags must be an unsigned byte");
  }
  const next = { ...(meta ?? {}) };
  delete next.traceparent;
  delete next.tracestate;
  delete next.baggage;
  next.traceparent =
    `00-${context.traceId}-${context.spanId}-${context.traceFlags.toString(16).padStart(2, "0")}`;
  const traceState = normalizeTraceState(context.traceState);
  if (traceState !== undefined) next.tracestate = traceState;
  return next;
}

/** Extract a validated W3C remote parent into canonical durable fields. */
export function extractMcpTraceContext(
  meta: McpMeta | undefined,
): ExtractedMcpTraceContext | undefined {
  const raw = meta?.traceparent;
  if (typeof raw !== "string") return undefined;
  const match = raw.match(TRACEPARENT);
  if (match === null) return undefined;
  const [, traceId, parentSpanId, flags] = match;
  if (!validTraceId(traceId) || !validSpanId(parentSpanId)) return undefined;
  const traceState = normalizeTraceState(meta?.tracestate);
  return {
    traceId,
    parentSpanId,
    traceFlags: Number.parseInt(flags, 16),
    ...(traceState === undefined ? {} : { traceState }),
    parentIsRemote: true,
  };
}

/** Durable event columns for a local MCP span or an extracted remote parent. */
export function mcpTraceEventFields(
  context: Pick<McpTraceContext, "traceFlags" | "traceState"> & {
    parentIsRemote?: boolean;
  },
  spanKind: McpSpanKind,
): Record<string, unknown> {
  const traceState = normalizeTraceState(context.traceState);
  return {
    trace_flags: context.traceFlags,
    ...(traceState === undefined ? {} : { trace_state: traceState }),
    span_kind: spanKind,
    parent_is_remote: context.parentIsRemote === true,
  };
}

export type McpCacheScope = "private" | "public";

export interface McpListFreshness {
  ttlMs: number;
  cacheScope: McpCacheScope;
  partition: string;
}

const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_IDENTITY_CODE_UNITS = 128;

function boundedCacheIdentity(value: string, field: string): string {
  if (value.length > MAX_CACHE_IDENTITY_CODE_UNITS) {
    throw new Error(`${field} exceeds 128 UTF-16 code units`);
  }
  return value;
}

/**
 * Resolve bounded freshness and an authorization-partitioned cache key.
 * `public` scope must be derived or authorized by the client; server-directed
 * metadata must never widen a private caller's cache visibility.
 */
export function resolveMcpListFreshness(input: {
  ttlMs?: unknown;
  cacheScope?: unknown;
  principalId: string;
  clearance: string;
}): McpListFreshness {
  const ttlMs = typeof input.ttlMs === "number" &&
      Number.isFinite(input.ttlMs) && input.ttlMs >= 0
    ? Math.min(Math.floor(input.ttlMs), MAX_CACHE_TTL_MS)
    : 0;
  const cacheScope = input.cacheScope === "public" ? "public" : "private";
  const clearance = boundedCacheIdentity(input.clearance, "clearance");
  const partition = cacheScope === "public"
    ? JSON.stringify(["public", clearance])
    : JSON.stringify([
      "private",
      boundedCacheIdentity(input.principalId, "principalId"),
      clearance,
    ]);
  return {
    ttlMs,
    cacheScope,
    partition,
  };
}

/** Stable UTF-16 code-unit ordering for protocol list fixtures. */
export function sortMcpList<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export type McpRetryOutcome =
  | "complete"
  | "input_required"
  | "cancelled"
  | "retry_new_request"
  | "fail";

/**
 * Safe retry classification for deterministic fixtures. A started mutation is
 * never retried. A broken read-only request, or a request proven not to have
 * started, is retried as a new request with a fresh request ID.
 */
export function classifyMcpRetry(input: {
  terminal?: "complete" | "input_required" | "cancelled";
  streamFailed?: boolean;
  readOnly: boolean;
  requestStarted: boolean;
}): McpRetryOutcome {
  if (input.terminal !== undefined) return input.terminal;
  if (!input.streamFailed) return "fail";
  if (!input.readOnly && input.requestStarted) return "fail";
  return "retry_new_request";
}

export interface JsonSchemaRefBounds {
  maxDepth: number;
  maxRefs: number;
}

/**
 * Resolve only local JSON Schema 2020-12 `$ref` pointers under explicit depth
 * and reference-count bounds. Remote refs and cycles fail closed.
 */
export function assertBoundedLocalJsonSchemaRefs(
  schema: unknown,
  bounds: JsonSchemaRefBounds = { maxDepth: 16, maxRefs: 64 },
): void {
  if (
    !Number.isInteger(bounds.maxDepth) || bounds.maxDepth < 0 ||
    !Number.isInteger(bounds.maxRefs) || bounds.maxRefs < 0
  ) throw new Error("JSON Schema ref bounds must be non-negative integers");
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("JSON Schema root must be an object");
  }
  let refs = 0;
  const activeRefs = new Set<string>();

  const resolvePointer = (pointer: string): unknown => {
    if (pointer === "#") return schema;
    if (!pointer.startsWith("#/")) throw new Error("only local JSON Schema refs are allowed");
    let current: unknown = schema;
    for (const token of pointer.slice(2).split("/")) {
      const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (typeof current !== "object" || current === null || !Object.hasOwn(current, decoded)) {
        throw new Error("unresolved local JSON Schema ref");
      }
      current = (current as Record<string, unknown>)[decoded];
    }
    return current;
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > bounds.maxDepth) throw new Error("JSON Schema ref depth exceeded");
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, "$ref")) {
      if (typeof object.$ref !== "string") throw new Error("JSON Schema $ref must be a string");
      refs++;
      if (refs > bounds.maxRefs) throw new Error("JSON Schema ref count exceeded");
      if (activeRefs.has(object.$ref)) throw new Error("cyclic JSON Schema ref");
      activeRefs.add(object.$ref);
      visit(resolvePointer(object.$ref), depth + 1);
      activeRefs.delete(object.$ref);
    }
    for (const [key, child] of Object.entries(object)) {
      if (key !== "$ref") visit(child, depth);
    }
  };

  visit(schema, 0);
}
