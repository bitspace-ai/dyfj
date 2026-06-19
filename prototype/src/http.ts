import {
  resolveRuntimeEnvDefaults,
  runWorkbenchRuntime,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeResult,
} from "./workbench";
import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  withDefaultLocalWorkbenchModels,
  type WorkbenchModel,
  type WorkbenchRoutingOptions,
} from "./provider";
import {
  buildConversationMessages,
  createProjectWorkbenchSession,
  fetchWorkbenchSessionEvents,
  isValidAsOfTimestamp,
  listWorkbenchSessions,
  type WorkbenchProjectSessions,
  type WorkbenchSessionEvent,
} from "./sessions";
import type { TurnReceipt, TurnStreamFrame } from "./turn-contract";

// Seam contract lock (BIT-136): the runtime result MUST satisfy the wire
// receipt. If a receipt field is dropped or renamed in WorkbenchRuntimeResult,
// this stops compiling here — before it can silently regress the HTTP/SSE path
// or drift from the client. `true` only if assignable; otherwise the type is
// `false` and this assignment fails to typecheck.
export const RUNTIME_RESULT_SATISFIES_TURN_RECEIPT:
  WorkbenchRuntimeResult extends TurnReceipt ? true : false = true;

export type WorkbenchHttpRuntime = (
  input: WorkbenchRuntimeInput,
) => Promise<WorkbenchRuntimeResult>;

export interface WorkbenchHttpAuthOptions {
  /** Bearer key required for non-loopback requests. Never logged. */
  apiKey?: string;
  /** Non-loopback hostnames (overlay-network IP/FQDN) permitted to reach the API. */
  allowedHosts?: string[];
}

export interface WorkbenchHttpHandlerOptions {
  runRuntime?: WorkbenchHttpRuntime;
  loadModels?: () => Promise<WorkbenchModel[]>;
  auth?: WorkbenchHttpAuthOptions;
  listSessions?: (options: {
    project?: string;
  }) => Promise<WorkbenchProjectSessions[]>;
  createSession?: (input: {
    project?: string;
    taskDescription?: string;
  }) => Promise<{ sessionId: string; slug: string; project: string | null }>;
  fetchSessionEvents?: (input: {
    sessionId: string;
    asOf?: string;
  }) => Promise<WorkbenchSessionEvent[]>;
}

const SESSION_ID_SHAPE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

async function loadPickerModels(): Promise<WorkbenchModel[]> {
  try {
    return withDefaultLocalWorkbenchModels(await loadWorkbenchModels());
  } catch {
    // Registry unavailable: degrade to the local defaults so the picker
    // keeps the local-first posture instead of returning an empty list.
    return defaultLocalWorkbenchModels();
  }
}

interface TurnRequestBody {
  prompt?: unknown;
  mode?: unknown;
  routingOptions?: unknown;
  sessionId?: unknown;
  workspace?: unknown;
}

export function createWorkbenchHttpHandler(
  options: WorkbenchHttpHandlerOptions = {},
): (request: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const runRuntime = options.runRuntime ?? runWorkbenchRuntime;
  const loadModels = options.loadModels ?? loadPickerModels;
  const listSessions = options.listSessions ?? listWorkbenchSessions;
  const createSession = options.createSession ??
    createProjectWorkbenchSession;
  const fetchSessionEvents = options.fetchSessionEvents ??
    fetchWorkbenchSessionEvents;
  const auth = options.auth ?? {};
  return async (request, info) => {
    const url = new URL(request.url);
    // Loopback is decided by the real TCP peer, never the request URL / Host
    // header (which a remote client forges to "127.0.0.1" to impersonate a
    // local operator and win full private-memory clearance).
    const peerLoopback = peerIsLoopback(info);
    if (request.method === "GET" && url.pathname === "/") {
      // Static shell only: no session or event data is embedded in the page,
      // so it is served on any bound interface without a bearer.
      const hostError = validateRequestHost(request, url, auth);
      if (hostError !== undefined) {
        return jsonResponse({ error: hostError }, 403);
      }
      return htmlResponse(renderWorkbenchIndex());
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      const resolved = await resolveWorkbenchAuth(request, url, auth, peerLoopback);
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      return jsonResponse({ models: await loadModels() });
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const resolved = await resolveWorkbenchAuth(request, url, auth, peerLoopback);
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      const project = url.searchParams.get("project") ?? undefined;
      try {
        return jsonResponse({ projects: await listSessions({ project }) });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const resolved = await resolveWorkbenchAuth(request, url, auth, peerLoopback);
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      let body: { project?: unknown; taskDescription?: unknown };
      try {
        body = await request.json() as typeof body;
      } catch {
        return jsonResponse({ error: "request body must be JSON" }, 400);
      }
      if (body.project !== undefined && typeof body.project !== "string") {
        return jsonResponse({ error: "project must be a string" }, 400);
      }
      if (
        body.taskDescription !== undefined &&
        typeof body.taskDescription !== "string"
      ) {
        return jsonResponse({ error: "taskDescription must be a string" }, 400);
      }
      try {
        const created = await createSession({
          project: body.project,
          taskDescription: body.taskDescription,
        });
        return jsonResponse(created, 201);
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 500);
      }
    }
    const eventsMatch = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/events$/,
    );
    if (request.method === "GET" && eventsMatch !== null) {
      const resolved = await resolveWorkbenchAuth(request, url, auth, peerLoopback);
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      const sessionId = eventsMatch[1];
      if (!SESSION_ID_SHAPE.test(sessionId)) {
        return jsonResponse({ error: "invalid session id" }, 400);
      }
      const asOf = url.searchParams.get("asOf") ?? undefined;
      if (asOf !== undefined && !isValidAsOfTimestamp(asOf)) {
        return jsonResponse(
          { error: "asOf must be a timestamp like 2026-06-12 10:00:00" },
          400,
        );
      }
      try {
        const events = await fetchSessionEvents({ sessionId, asOf });
        return jsonResponse({ sessionId, asOf: asOf ?? null, events });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/turn") {
      const resolved = await resolveWorkbenchAuth(request, url, auth, peerLoopback);
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      const contentType = request.headers.get("content-type")?.split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        return jsonResponse(
          { error: "content-type must be application/json" },
          403,
        );
      }
      const wantsStream = request.headers.get("accept")
        ?.toLowerCase().includes("text/event-stream") ?? false;
      return wantsStream
        ? await handleStreamingTurn(
          request,
          runRuntime,
          resolved,
          fetchSessionEvents,
        )
        : await handleJsonTurn(
          request,
          runRuntime,
          resolved,
          fetchSessionEvents,
        );
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

/**
 * Resolve transport + authentication for an API request.
 *
 * Posture:
 *   - Loopback requests work without a bearer (local dev path). A presented
 *     bearer is still verified; a wrong one is rejected rather than ignored.
 *   - Non-loopback requests are accepted only when the hostname is explicitly
 *     allowed AND a bearer key is configured AND the request presents it.
 *   - No key configured means no non-loopback access. Fail closed.
 *
 * `peerLoopback` is derived from the TCP peer address (info.remoteAddr), NOT
 * from the request URL / Host header. A remote client can set Host: 127.0.0.1,
 * but it cannot forge its source IP, so loopback clearance is decided by the
 * connection, not by attacker-controlled headers.
 */
async function resolveWorkbenchAuth(
  request: Request,
  url: URL,
  auth: WorkbenchHttpAuthOptions,
  peerLoopback: boolean,
): Promise<WorkbenchAuthContext | { error: string; status: number }> {
  const hostError = validateRequestHost(request, url, auth);
  if (hostError !== undefined) {
    return { error: hostError, status: 403 };
  }

  const originError = validateRequestOrigin(request, auth);
  if (originError !== undefined) {
    return { error: originError, status: 403 };
  }

  const isLoopback = peerLoopback;
  const bearer = parseBearerToken(request.headers.get("authorization"));

  if (bearer !== undefined) {
    if (auth.apiKey === undefined || auth.apiKey.length === 0) {
      return { error: "bearer auth is not configured", status: 401 };
    }
    if (!(await bearerMatches(bearer, auth.apiKey))) {
      return { error: "invalid bearer credentials", status: 401 };
    }
    return {
      transport: isLoopback ? "loopback" : "remote",
      authnStatus: "authenticated",
      authnMechanism: "api_key",
      authnIssuerRef: "workbench_api_key",
      authzBasis: "capability:workbench-api-key",
    };
  }

  if (!isLoopback) {
    return { error: "non-loopback requests require bearer auth", status: 401 };
  }

  return {
    transport: "loopback",
    authnStatus: "unauthenticated",
    authnMechanism: "local_user",
    authnIssuerRef: "local_os",
    authzBasis: "policy:loopback-local",
  };
}

function validateRequestHost(
  request: Request,
  url: URL,
  auth: WorkbenchHttpAuthOptions,
): string | undefined {
  if (!isAllowedHost(url.hostname, auth)) {
    return "workbench HTTP API only accepts loopback or allowed remote hosts";
  }
  const host = request.headers.get("host");
  if (host !== null && !isAllowedHost(parseHostHeader(host), auth)) {
    return "workbench HTTP API only accepts loopback or allowed remote hosts";
  }
  return undefined;
}

function validateRequestOrigin(
  request: Request,
  auth: WorkbenchHttpAuthOptions,
): string | undefined {
  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return "cross-site workbench requests are not allowed";
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return "invalid request origin";
    }
    if (!isAllowedHost(originUrl.hostname, auth)) {
      return "cross-origin workbench requests are not allowed";
    }
  }
  return undefined;
}

function isAllowedHost(
  hostname: string,
  auth: WorkbenchHttpAuthOptions,
): boolean {
  if (isLoopbackHost(hostname)) return true;
  const normalized = hostname.toLowerCase();
  return (auth.allowedHosts ?? []).some((allowed) =>
    allowed.toLowerCase() === normalized
  );
}

function parseBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

/**
 * Compare a presented bearer against the configured key without a
 * length-dependent early exit: both values are hashed to fixed-size
 * digests and compared byte-for-byte.
 */
async function bearerMatches(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const bytesA = new Uint8Array(a);
  const bytesB = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

function parseHostHeader(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  return host.split(":")[0] ?? host;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

/**
 * Decide loopback from the actual TCP peer. A unix-socket peer is local. When
 * no ServeHandlerInfo is present the handler was invoked in-process (tests or a
 * trusted embedding), which is itself local — network requests always carry it.
 */
function peerIsLoopback(info?: Deno.ServeHandlerInfo): boolean {
  const addr = info?.remoteAddr;
  if (addr === undefined) return true;
  if (addr.transport !== "tcp" && addr.transport !== "udp") return true;
  return isLoopbackHost(addr.hostname);
}

const PAID_ESCALATION_OVER_HTTP =
  "paid inference requires an explicit CLI consent flow";

/**
 * Per-session turn serialization (BIT-147). Two concurrent turns for the same
 * session would split-brain the append-only event log — each reads the prior
 * events and appends its own — and race the shared Dolt pool. Chain same-session
 * turns so they run one at a time: the operator's second turn runs after the
 * first rather than being dropped. New turns (no sessionId) target fresh
 * sessions and never collide, so they run immediately without serialization.
 */
const sessionTurnChains = new Map<string, Promise<unknown>>();

function withSessionTurnLock<T>(
  sessionId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (sessionId === undefined) return run();
  const prior = sessionTurnChains.get(sessionId) ?? Promise.resolve();
  // Run after the prior turn settles, whether it resolved or rejected.
  const result = prior.then(run, run);
  const settled = result.then(() => {}, () => {});
  sessionTurnChains.set(sessionId, settled);
  void settled.finally(() => {
    // Drop the chain once this turn is the tail, so the map does not grow.
    if (sessionTurnChains.get(sessionId) === settled) {
      sessionTurnChains.delete(sessionId);
    }
  });
  return result;
}

/**
 * Parse and validate a turn request body into runtime input plus the validated
 * resume sessionId. Shared by the buffered and streaming turn handlers.
 *
 * Deliberately does NOT read the session's prior events: transcript
 * reconstruction is deferred into the per-session lock (see `buildResume`) so a
 * resumed turn reads the latest committed events only after all earlier
 * same-session turns have appended theirs. Reading here (before the lock) let a
 * second same-session turn build a stale transcript — a TOCTOU on the audit log
 * (BIT-147 review finding).
 */
async function resolveTurnRequest(
  request: Request,
): Promise<
  | { runtimeInput: WorkbenchRuntimeInput; sessionId: string | undefined }
  | { error: string; status: number }
> {
  let body: TurnRequestBody;
  try {
    body = await request.json() as TurnRequestBody;
  } catch {
    return { error: "request body must be JSON", status: 400 };
  }

  const runtimeInput = buildRuntimeInputFromJson(body);
  if ("error" in runtimeInput) {
    return { error: runtimeInput.error, status: 400 };
  }

  let sessionId: string | undefined;
  if (body.sessionId !== undefined) {
    if (
      typeof body.sessionId !== "string" ||
      !SESSION_ID_SHAPE.test(body.sessionId)
    ) {
      return { error: "invalid session id", status: 400 };
    }
    sessionId = body.sessionId;
  }

  return { runtimeInput, sessionId };
}

/**
 * Rebuild the resume context (prior turns as conversation messages). Called
 * INSIDE `withSessionTurnLock` so the prior-event read happens after all earlier
 * same-session turns have settled — keeping the read-modify-append atomic per
 * session (BIT-147).
 */
async function buildResume(
  sessionId: string | undefined,
  fetchSessionEvents: NonNullable<
    WorkbenchHttpHandlerOptions["fetchSessionEvents"]
  >,
): Promise<Pick<WorkbenchRuntimeInput, "sessionId" | "conversationMessages">> {
  if (sessionId === undefined) return {};
  const priorEvents = await fetchSessionEvents({ sessionId });
  return {
    sessionId,
    conversationMessages: buildConversationMessages(priorEvents),
  };
}

async function handleJsonTurn(
  request: Request,
  runRuntime: WorkbenchHttpRuntime,
  authContext: WorkbenchAuthContext,
  fetchSessionEvents: NonNullable<
    WorkbenchHttpHandlerOptions["fetchSessionEvents"]
  >,
): Promise<Response> {
  const resolved = await resolveTurnRequest(request);
  if ("error" in resolved) {
    return jsonResponse({ error: resolved.error }, resolved.status);
  }
  const { runtimeInput, sessionId } = resolved;

  try {
    const events: WorkbenchRuntimeEvent[] = [];
    const result = await withSessionTurnLock(sessionId, async () => {
      const resume = await buildResume(sessionId, fetchSessionEvents);
      return runRuntime({
        ...runtimeInput,
        ...resume,
        // BIT-148: env-derived runtime config resolved at the boundary, not in
        // the core. A future headless driver supplies these from its own config.
        ...resolveRuntimeEnvDefaults(),
        authContext,
        onRuntimeEvent: (event) => {
          events.push(event);
        },
        confirmPaidEscalation: () =>
          Promise.resolve({
            decision: "deny" as const,
            reason: PAID_ESCALATION_OVER_HTTP,
          }),
      });
    });
    return jsonResponse({ ...result, events });
  } catch (err) {
    return jsonResponse({
      error: (err as Error)?.message ?? String(err),
    }, 500);
  }
}

/**
 * Stream a turn as Server-Sent Events. Negotiated via `Accept:
 * text/event-stream`; the buffered JSON path stays the default so existing
 * clients are unaffected. Each frame is `data: <json>\n\n` with a `t`
 * discriminator:
 *   { t: "delta", text }      incremental model text
 *   { t: "event", event }     a WorkbenchRuntimeEvent lifecycle record
 *   { t: "done",  result }    terminal success — full WorkbenchRuntimeResult
 *   { t: "error", message }   terminal failure
 */
async function handleStreamingTurn(
  request: Request,
  runRuntime: WorkbenchHttpRuntime,
  authContext: WorkbenchAuthContext,
  fetchSessionEvents: NonNullable<
    WorkbenchHttpHandlerOptions["fetchSessionEvents"]
  >,
): Promise<Response> {
  const resolved = await resolveTurnRequest(request);
  if ("error" in resolved) {
    // Request-shape errors occur before the stream opens, so report them as a
    // plain JSON error response rather than an SSE error frame.
    return jsonResponse({ error: resolved.error }, resolved.status);
  }
  const { runtimeInput, sessionId } = resolved;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: TurnStreamFrame): void =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      try {
        const result = await withSessionTurnLock(sessionId, async () => {
          const resume = await buildResume(sessionId, fetchSessionEvents);
          return runRuntime({
            ...runtimeInput,
            ...resume,
            // BIT-148: env-derived runtime config resolved at the boundary.
            ...resolveRuntimeEnvDefaults(),
            authContext,
            onTextDelta: (delta) => send({ t: "delta", text: delta }),
            onRuntimeEvent: (event) => {
              send({ t: "event", event });
            },
            confirmPaidEscalation: () =>
              Promise.resolve({
                decision: "deny" as const,
                reason: PAID_ESCALATION_OVER_HTTP,
              }),
          });
        });
        send({ t: "done", result });
      } catch (err) {
        send({ t: "error", message: (err as Error)?.message ?? String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

function buildRuntimeInputFromJson(
  body: TurnRequestBody,
): WorkbenchRuntimeInput | { error: string } {
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return { error: "prompt must be a non-empty string" };
  }
  const mode = body.mode ?? "turn";
  if (mode !== "turn" && mode !== "ask" && mode !== "next-work") {
    return { error: "mode must be turn, ask, or next-work" };
  }
  const routingOptions = parseRoutingOptions(body.routingOptions);
  if ("error" in routingOptions) return routingOptions;
  if (body.workspace !== undefined && typeof body.workspace !== "string") {
    return { error: "workspace must be a string" };
  }
  return {
    mode,
    prompt: body.prompt,
    routingOptions,
    // Honored only for a loopback operator; the runtime applies that gate.
    ...(typeof body.workspace === "string"
      ? { workspaceRoot: body.workspace }
      : {}),
  };
}

function parseRoutingOptions(
  value: unknown,
): WorkbenchRoutingOptions | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "routingOptions must be an object" };
  }
  const input = value as Record<string, unknown>;
  const output: WorkbenchRoutingOptions = {};
  if ("modelId" in input) {
    if (typeof input.modelId !== "string") {
      return { error: "routingOptions.modelId must be a string" };
    }
    output.modelId = input.modelId;
  }
  if ("tier" in input) {
    if (input.tier !== 0 && input.tier !== 1 && input.tier !== 2) {
      return { error: "routingOptions.tier must be 0, 1, or 2" };
    }
    output.tier = input.tier;
  }
  if ("hint" in input) {
    if (
      input.hint !== "code" && input.hint !== "chat" &&
      input.hint !== "reasoning"
    ) {
      return { error: "routingOptions.hint must be code, chat, or reasoning" };
    }
    output.hint = input.hint;
  }
  return output;
}

function renderWorkbenchIndex(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DYFJ Workbench</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7f8;
        --panel: #ffffff;
        --ink: #162027;
        --muted: #64727d;
        --line: #d7dee3;
        --line-strong: #b9c5cc;
        --accent: #236f73;
        --accent-strong: #18585b;
        --warn: #a64b14;
        --error: #b42318;
        --code: #eef3f2;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }

      button,
      textarea,
      input,
      select {
        font: inherit;
      }

      button {
        border: 1px solid var(--accent-strong);
        border-radius: 6px;
        background: var(--accent);
        color: #ffffff;
        cursor: pointer;
        font-weight: 650;
        min-height: 38px;
        padding: 0 14px;
      }

      button:hover {
        background: var(--accent-strong);
      }

      button:disabled {
        cursor: wait;
        opacity: 0.62;
      }

      .shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
      }

      header {
        display: grid;
        grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
        gap: 18px;
        align-items: center;
        border-bottom: 1px solid var(--line);
        background: #ffffff;
        padding: 12px 18px;
      }

      h1,
      h2 {
        margin: 0;
        letter-spacing: 0;
      }

      h1 {
        font-size: 18px;
        font-weight: 750;
      }

      h2 {
        font-size: 13px;
        font-weight: 750;
        text-transform: uppercase;
        color: var(--muted);
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(8, minmax(96px, 1fr));
        gap: 8px;
      }

      .fact {
        border-left: 1px solid var(--line);
        min-width: 0;
        padding-left: 10px;
      }

      .fact span {
        display: block;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .fact strong {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      main {
        display: grid;
        grid-template-columns: minmax(340px, 1fr) minmax(280px, 360px);
        gap: 14px;
        min-height: 0;
        padding: 14px;
      }

      .lane,
      aside {
        min-height: 0;
      }

      .lane {
        display: grid;
        grid-template-rows: auto minmax(220px, 1fr);
        gap: 14px;
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      form.panel {
        display: grid;
        gap: 10px;
        padding: 12px;
      }

      label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 750;
        text-transform: uppercase;
      }

      textarea,
      input,
      select {
        width: 100%;
        border: 1px solid var(--line-strong);
        border-radius: 6px;
        background: #ffffff;
        color: var(--ink);
        min-width: 0;
      }

      textarea {
        min-height: 116px;
        padding: 10px;
        resize: vertical;
      }

      input,
      select {
        min-height: 36px;
        padding: 0 9px;
      }

      .controls {
        display: grid;
        grid-template-columns: 130px 1fr 108px 130px auto;
        gap: 10px;
        align-items: end;
      }

      .response {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }

      .response h2,
      aside h2 {
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
      }

      .result {
        overflow: auto;
        padding: 14px;
        white-space: pre-wrap;
      }

      .empty {
        color: var(--muted);
      }

      aside {
        display: grid;
        grid-template-rows: minmax(180px, 0.92fr) minmax(200px, 1fr);
        gap: 14px;
      }

      .timeline {
        min-height: 0;
        overflow: auto;
        padding: 8px;
      }

      .event {
        display: grid;
        grid-template-columns: 26px minmax(0, 1fr);
        gap: 8px;
        width: 100%;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--ink);
        cursor: pointer;
        min-height: 44px;
        padding: 7px;
        text-align: left;
      }

      .event:hover,
      .event.selected {
        border-color: var(--line-strong);
        background: #f1f6f5;
      }

      .event-index {
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: var(--code);
        color: var(--accent-strong);
        font-size: 12px;
        font-weight: 800;
        height: 24px;
        width: 24px;
      }

      .event strong,
      .event span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .event span {
        color: var(--muted);
        font-size: 12px;
      }

      .inspector {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }

      pre {
        margin: 0;
        overflow: auto;
        background: var(--code);
        color: #243136;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
        padding: 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .key-bar {
        display: grid;
        gap: 10px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 10px;
      }

      .key-bar[hidden] {
        display: none;
      }

      .error {
        display: none;
        border: 1px solid #efb5ad;
        border-radius: 6px;
        background: #fff4f2;
        color: var(--error);
        padding: 9px 10px;
      }

      .error.visible {
        display: block;
      }

      .cost-paid {
        color: var(--warn);
      }

      @media (max-width: 980px) {
        header,
        main,
        aside,
        .lane {
          display: block;
        }

        header > *,
        main > *,
        aside > *,
        .lane > * {
          margin-bottom: 12px;
        }

        .facts,
        .controls {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .controls button {
          grid-column: 1 / -1;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>DYFJ Workbench</h1>
        <section class="facts" aria-label="Turn facts">
          <div class="fact"><span>Session</span><strong id="fact-session">-</strong></div>
          <div class="fact"><span>Trace</span><strong id="fact-trace">-</strong></div>
          <div class="fact"><span>Model</span><strong id="fact-model">-</strong></div>
          <div class="fact"><span>Tier</span><strong id="fact-tier">-</strong></div>
          <div class="fact"><span>Route</span><strong id="fact-route">-</strong></div>
          <div class="fact"><span>Cost</span><strong id="fact-cost">-</strong></div>
          <div class="fact"><span>Tokens</span><strong id="fact-tokens">-</strong></div>
          <div class="fact"><span>Calls</span><strong id="fact-calls">-</strong></div>
        </section>
      </header>

      <main>
        <section class="lane" aria-label="Conversation">
          <form class="panel" id="turn-form">
            <div id="key-bar" class="key-bar" hidden>
              <label for="api-key">API key (remote access)</label>
              <div class="controls" style="grid-template-columns: 1fr auto;">
                <input id="api-key" type="password" autocomplete="off">
                <button id="save-key" type="button">Save key</button>
              </div>
            </div>
            <label for="prompt">Prompt</label>
            <textarea id="prompt" name="prompt" required autocomplete="off" spellcheck="true"></textarea>
            <div class="controls">
              <div>
                <label for="mode">Mode</label>
                <select id="mode" name="mode">
                  <option value="turn">Turn</option>
                  <option value="ask">Ask</option>
                  <option value="next-work">Next work</option>
                </select>
              </div>
              <div>
                <label for="model-id">Model</label>
                <input id="model-id" name="modelId" placeholder="default">
              </div>
              <div>
                <label for="tier">Tier</label>
                <select id="tier" name="tier">
                  <option value="">Auto</option>
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </div>
              <div>
                <label for="hint">Hint</label>
                <select id="hint" name="hint">
                  <option value="">None</option>
                  <option value="chat">Chat</option>
                  <option value="code">Code</option>
                  <option value="reasoning">Reasoning</option>
                </select>
              </div>
              <button id="run-button" type="submit">Run</button>
            </div>
            <div class="error" id="error" role="alert"></div>
          </form>

          <section class="panel response" aria-label="Assistant response">
            <h2>Response</h2>
            <div class="result empty" id="response-text">No turn yet.</div>
          </section>
        </section>

        <aside aria-label="Runtime events">
          <section class="panel">
            <h2>Timeline</h2>
            <div class="timeline" id="timeline">
              <p class="empty">No events yet.</p>
            </div>
          </section>
          <section class="panel inspector">
            <h2>Inspector</h2>
            <pre id="inspector">{}</pre>
          </section>
        </aside>
      </main>
    </div>

    <script type="module">
      const form = document.querySelector("#turn-form");
      const button = document.querySelector("#run-button");
      const errorBox = document.querySelector("#error");
      const responseText = document.querySelector("#response-text");
      const timeline = document.querySelector("#timeline");
      const inspector = document.querySelector("#inspector");
      const facts = {
        session: document.querySelector("#fact-session"),
        trace: document.querySelector("#fact-trace"),
        model: document.querySelector("#fact-model"),
        tier: document.querySelector("#fact-tier"),
        route: document.querySelector("#fact-route"),
        cost: document.querySelector("#fact-cost"),
        tokens: document.querySelector("#fact-tokens"),
        calls: document.querySelector("#fact-calls"),
      };

      let events = [];
      let selectedEventIndex = -1;

      const keyBar = document.querySelector("#key-bar");
      const keyInput = document.querySelector("#api-key");
      const saveKeyButton = document.querySelector("#save-key");
      const KEY_STORAGE = "dyfj-workbench-api-key";
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"]
        .includes(location.hostname);

      function storedApiKey() {
        try {
          return localStorage.getItem(KEY_STORAGE) ?? "";
        } catch {
          return "";
        }
      }

      function showKeyBar() {
        keyBar.hidden = false;
      }

      saveKeyButton.addEventListener("click", () => {
        try {
          localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
        } catch {
          showError("could not persist the API key in this browser");
          return;
        }
        keyInput.value = "";
        keyBar.hidden = true;
        clearError();
      });

      if (!isLoopback && storedApiKey() === "") {
        showKeyBar();
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError();
        setBusy(true);

        const formData = new FormData(form);
        const routingOptions = {};
        const modelId = String(formData.get("modelId") ?? "").trim();
        const tier = String(formData.get("tier") ?? "");
        const hint = String(formData.get("hint") ?? "");
        if (modelId) routingOptions.modelId = modelId;
        if (tier) routingOptions.tier = Number(tier);
        if (hint) routingOptions.hint = hint;

        const body = {
          prompt: String(formData.get("prompt") ?? ""),
          mode: String(formData.get("mode") ?? "turn"),
          routingOptions,
        };

        try {
          const headers = { "content-type": "application/json" };
          const apiKey = storedApiKey();
          if (apiKey !== "") headers["authorization"] = "Bearer " + apiKey;
          const response = await fetch("/api/turn", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok) {
            if (response.status === 401) showKeyBar();
            throw new Error(payload.error ?? "request failed");
          }
          renderTurn(payload);
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      });

      function renderTurn(payload) {
        events = Array.isArray(payload.events) ? payload.events : [];
        selectedEventIndex = events.length > 0 ? events.length - 1 : -1;
        responseText.classList.remove("empty");
        responseText.textContent = payload.text || "";
        renderFacts(payload);
        renderTimeline();
        renderInspector();
      }

      function renderFacts(payload) {
        facts.session.textContent = payload.sessionId ?? "-";
        facts.trace.textContent = payload.traceId ?? "-";
        facts.model.textContent = payload.model?.displayName ?? payload.model?.slug ?? "-";
        facts.tier.textContent = payload.model?.tier ?? "-";
        facts.route.textContent = payload.route?.reason ?? "-";
        facts.cost.textContent = formatCost(payload.cost);
        facts.cost.classList.toggle("cost-paid", Boolean(payload.cost?.paidInferenceUsed));
        facts.tokens.textContent = formatTokens(payload.tokens);
        facts.calls.textContent = payload.tokens?.totalCalls ?? "-";
      }

      function renderTimeline() {
        timeline.replaceChildren();
        if (events.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = "No events.";
          timeline.append(empty);
          return;
        }
        for (const [index, event] of events.entries()) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "event" + (index === selectedEventIndex ? " selected" : "");
          item.addEventListener("click", () => {
            selectedEventIndex = index;
            renderTimeline();
            renderInspector();
          });

          const badge = document.createElement("span");
          badge.className = "event-index";
          badge.textContent = String(index + 1);

          const text = document.createElement("span");
          const name = document.createElement("strong");
          name.textContent = event.type ?? "event";
          const detail = document.createElement("span");
          detail.textContent = summarizeEvent(event);
          text.append(name, detail);
          item.append(badge, text);
          timeline.append(item);
        }
      }

      function renderInspector() {
        const event = events[selectedEventIndex];
        if (!event || typeof event !== "object") {
          inspector.textContent = "No event selected.";
          return;
        }
        const rows = [];
        for (const [key, value] of Object.entries(event)) {
          if (value === null || value === undefined || value === "") continue;
          const rendered = typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
          rows.push(humanizeKey(key).padEnd(16) + " " + rendered);
        }
        inspector.textContent = rows.length > 0
          ? rows.join("\n")
          : "(empty event)";
      }

      function summarizeEvent(event) {
        if (!event || typeof event !== "object") return "";
        if (event.modelSlug) return [event.modelSlug, event.reason].filter(Boolean).join(" | ");
        if (event.traceId) return event.traceId;
        if (event.sourceCount !== undefined) return event.sourceCount + " sources";
        if (event.inputCount !== undefined || event.outputCount !== undefined) {
          return (event.inputCount ?? 0) + " in / " + (event.outputCount ?? 0) + " out";
        }
        if (event.promptLength !== undefined) return event.promptLength + " chars";
        return event.sessionId ?? "";
      }

      function formatCost(cost) {
        if (!cost) return "-";
        const estimated = Number(cost.estimatedUsd ?? 0).toFixed(6);
        const actual = Number(cost.totalUsd ?? 0).toFixed(6);
        return "$" + actual + " / est $" + estimated;
      }

      function formatTokens(tokens) {
        if (!tokens) return "-";
        let line = (tokens.input ?? 0) + " in / " + (tokens.output ?? 0) + " out";
        const cacheRead = tokens.cacheRead ?? 0;
        const cacheWrite = tokens.cacheWrite ?? 0;
        if (cacheRead || cacheWrite) {
          line += " · cache " + cacheRead + "r / " + cacheWrite + "w";
        }
        return line;
      }

      function humanizeKey(key) {
        return String(key)
          .replace(/_/g, " ")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/^./, function (c) { return c.toUpperCase(); });
      }

      function setBusy(isBusy) {
        button.disabled = isBusy;
        button.textContent = isBusy ? "Running" : "Run";
      }

      function showError(message) {
        errorBox.textContent = message;
        errorBox.classList.add("visible");
      }

      function clearError() {
        errorBox.textContent = "";
        errorBox.classList.remove("visible");
      }
    </script>
  </body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("DYFJ_WORKBENCH_HTTP_PORT") ?? "8787");
  const hostnames = (Deno.env.get("DYFJ_WORKBENCH_HTTP_HOST") ?? "127.0.0.1")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const apiKey = Deno.env.get("DYFJ_WORKBENCH_API_KEY");
  const nonLoopback = hostnames.filter((name) => !isLoopbackHost(name));
  const allowedHosts = [
    ...nonLoopback,
    ...(Deno.env.get("DYFJ_WORKBENCH_ALLOWED_HOSTS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  ];

  if (nonLoopback.length > 0 && (apiKey === undefined || apiKey.length === 0)) {
    console.error(
      "Refusing to bind non-loopback interfaces without DYFJ_WORKBENCH_API_KEY set.",
    );
    Deno.exit(1);
  }

  const handler = createWorkbenchHttpHandler({
    auth: { apiKey, allowedHosts },
  });
  let bound = 0;
  for (const hostname of hostnames) {
    try {
      Deno.serve({ hostname, port }, handler);
      bound += 1;
    } catch (err) {
      // A down overlay-network interface must not take the loopback server with it.
      console.error(
        `Could not bind ${hostname}:${port}: ${(err as Error).message}`,
      );
    }
  }
  if (bound === 0) {
    console.error("No interfaces bound; exiting.");
    Deno.exit(1);
  }
}
