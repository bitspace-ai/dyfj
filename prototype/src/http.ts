import {
  runWorkbenchRuntime,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeResult,
} from "./workbench";
import {
  defaultLocalWorkbenchModels,
  loadWorkbenchModels,
  modelHasCatalogPricing,
  withDefaultLocalWorkbenchModels,
  type WorkbenchModel,
} from "./provider";
import {
  createProjectWorkbenchSession,
  fetchWorkbenchSessionEvents,
  isValidAsOfTimestamp,
  listWorkbenchSessions,
  type WorkbenchProjectSessions,
  type WorkbenchSessionEvent,
} from "./sessions";
import type { TurnReceipt, TurnStreamFrame } from "./turn-contract";
import type { WorkbenchConfig } from "./config";
import { loadConfig, loadSecretsConfig } from "./config";
import { resolveSecretsIntoEnv } from "./secrets";
import {
  engineConfigToTurnDeps,
  executeTurn,
  type ResolvedTurn,
  resolveTurnFromBody,
  type TurnRequestBody,
} from "./turn-runner";

// Seam contract lock: the runtime result MUST satisfy the wire
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
  /** Loaded engine config (companion, posture, budget defaults, anomaly multiples). */
  engineConfig?: Pick<
    WorkbenchConfig,
    | "defaultCompanionModel"
    | "permissionLevel"
    | "approvePaidDefault"
    | "defaultSessionBudgetUsd"
    | "defaultPerCallBudgetUsd"
    | "defaultDailyBudgetUsd"
    | "anomalyTurnMultiple"
    | "anomalyScopeMultiple"
  >;
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
  const engineDeps = options.engineConfig !== undefined
    ? engineConfigToTurnDeps(options.engineConfig)
    : {};
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
      const resolved = await resolveWorkbenchAuth(
        request,
        url,
        auth,
        peerLoopback,
      );
      if ("error" in resolved) {
        return jsonResponse({ error: resolved.error }, resolved.status);
      }
      // `routable` is computed server-side (single source: modelHasCatalogPricing)
      // so the picker can mark unpriced rows without duplicating the pricing rule.
      return jsonResponse({
        models: (await loadModels()).map((model) => ({
          ...model,
          routable: modelHasCatalogPricing(model),
        })),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const resolved = await resolveWorkbenchAuth(
        request,
        url,
        auth,
        peerLoopback,
      );
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
      const resolved = await resolveWorkbenchAuth(
        request,
        url,
        auth,
        peerLoopback,
      );
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
      const resolved = await resolveWorkbenchAuth(
        request,
        url,
        auth,
        peerLoopback,
      );
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
      const resolved = await resolveWorkbenchAuth(
        request,
        url,
        auth,
        peerLoopback,
      );
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
          engineDeps,
        )
        : await handleJsonTurn(
          request,
          runRuntime,
          resolved,
          fetchSessionEvents,
          engineDeps,
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

// Parse the HTTP request body, then resolve it through the shared turn core.
async function resolveTurnRequest(
  request: Request,
  loopback: boolean,
  approvePaidDefault?: boolean,
): Promise<ResolvedTurn | { error: string; status: number }> {
  let body: TurnRequestBody;
  try {
    body = await request.json() as TurnRequestBody;
  } catch {
    return { error: "request body must be JSON", status: 400 };
  }
  return resolveTurnFromBody(body, loopback, { approvePaidDefault });
}

async function handleJsonTurn(
  request: Request,
  runRuntime: WorkbenchHttpRuntime,
  authContext: WorkbenchAuthContext,
  fetchSessionEvents: NonNullable<
    WorkbenchHttpHandlerOptions["fetchSessionEvents"]
  >,
  engineDeps: ReturnType<typeof engineConfigToTurnDeps> = {},
): Promise<Response> {
  const loopback = authContext.transport === "loopback";
  const resolved = await resolveTurnRequest(
    request,
    loopback,
    engineDeps.approvePaidDefault,
  );
  if ("error" in resolved) {
    return jsonResponse({ error: resolved.error }, resolved.status);
  }
  try {
    const events: WorkbenchRuntimeEvent[] = [];
    const result = await executeTurn(resolved, {
      authContext,
      loopback,
      runRuntime,
      fetchSessionEvents,
      ...engineDeps,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
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
  engineDeps: ReturnType<typeof engineConfigToTurnDeps> = {},
): Promise<Response> {
  const loopback = authContext.transport === "loopback";
  const resolved = await resolveTurnRequest(
    request,
    loopback,
    engineDeps.approvePaidDefault,
  );
  if ("error" in resolved) {
    // Request-shape errors occur before the stream opens, so report them as a
    // plain JSON error response rather than an SSE error frame.
    return jsonResponse({ error: resolved.error }, resolved.status);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: TurnStreamFrame): void =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      try {
        const result = await executeTurn(resolved, {
          authContext,
          loopback,
          runRuntime,
          fetchSessionEvents,
          ...engineDeps,
          onTextDelta: (delta) => send({ t: "delta", text: delta }),
          onRuntimeEvent: (event) => {
            send({ t: "event", event });
          },
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

// NOTE: the entire document — including the inline <script> — is one template
// literal. Any backslash escape in the embedded JS must be DOUBLED in source
// (`"\\n"`, `/\\s+/g`) or the template literal eats it before it reaches the
// browser (a bare "\n" becomes a real newline → SyntaxError). The
// "served shell script parses" test in http.test.ts guards this.
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
        height: 100vh;
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
        grid-template-columns: minmax(208px, 248px) minmax(0, 1fr);
        height: 100vh;
        overflow: hidden;
      }

      .content {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }

      .work {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 10px;
        border-right: 1px solid var(--line);
        background: #ffffff;
        padding: 12px;
        min-height: 0;
      }

      .work-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      #new-session {
        padding: 4px 10px;
        font-size: 12px;
      }

      .work-list {
        overflow: auto;
        min-height: 0;
        display: grid;
        align-content: start;
        gap: 3px;
      }

      .work-group-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--muted);
        padding: 10px 4px 2px;
      }

      .session-item {
        display: block;
        width: 100%;
        text-align: left;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 6px 8px;
        background: transparent;
        cursor: pointer;
        font: inherit;
        color: inherit;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .session-item:hover {
        background: var(--panel);
      }

      .session-item[aria-current="true"] {
        border-color: var(--line);
        background: var(--panel);
        font-weight: 650;
      }

      .session-item small {
        display: block;
        color: var(--muted);
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
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

      .model-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }

      #cap-filter {
        width: auto;
        min-height: 0;
        height: 20px;
        font-size: 11px;
        padding: 0 4px;
        text-transform: none;
        color: var(--muted);
      }

      select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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

      .budget-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 10px;
        font-size: 12px;
        color: var(--muted);
      }

      .budget-row label {
        text-transform: none;
        font-weight: 600;
      }

      .budget-row input {
        width: 84px;
        min-height: 28px;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 23, 0.42);
        display: grid;
        place-items: center;
        z-index: 50;
      }

      .modal-backdrop[hidden] {
        display: none;
      }

      .modal-card {
        background: #ffffff;
        border: 1px solid var(--line-strong);
        border-radius: 10px;
        padding: 20px 22px;
        max-width: 440px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
      }

      .modal-card h2 {
        text-transform: none;
        color: var(--ink);
        font-size: 16px;
        margin: 0 0 10px;
      }

      .modal-card p {
        margin: 0 0 8px;
        color: var(--ink);
        text-transform: none;
        font-weight: 500;
      }

      .modal-q {
        font-weight: 650;
      }

      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 16px;
      }

      .modal-actions button {
        width: auto;
        padding: 6px 16px;
      }

      .modal-actions button:not(.primary) {
        background: #ffffff;
        color: var(--ink);
        border-color: var(--line-strong);
      }

      @media (max-width: 980px) {
        .shell {
          display: block;
          height: auto;
          overflow: visible;
        }

        .work {
          border-right: none;
          border-bottom: 1px solid var(--line);
          max-height: 220px;
        }

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
      <nav class="work" aria-label="Work sessions">
        <div class="work-head">
          <h2>Work</h2>
          <button id="new-session" type="button">+ New</button>
        </div>
        <div class="work-list" id="work-list">
          <p class="empty">No sessions yet.</p>
        </div>
      </nav>
      <div class="content">
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
                <div class="model-head">
                  <label for="model-id">Model</label>
                  <select id="cap-filter" title="Filter models by capability"
                    aria-label="Filter models by capability">
                    <option value="">all capabilities</option>
                    <option value="code">code</option>
                    <option value="reasoning">reasoning</option>
                    <option value="vision">vision</option>
                    <option value="long-context">long-context</option>
                  </select>
                </div>
                <select id="model-id" name="modelId">
                  <option value="">Auto (smart routing)</option>
                </select>
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
            <div class="budget-row">
              <span>Budget override (optional, this session)</span>
              <label for="budget-session">session $</label>
              <input id="budget-session" type="number" min="0" step="0.01"
                inputmode="decimal" placeholder="1.00">
              <label for="budget-per-call">per-call $</label>
              <input id="budget-per-call" type="number" min="0" step="0.01"
                inputmode="decimal" placeholder="0.10">
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
    </div>

    <div class="modal-backdrop" id="paid-modal" hidden>
      <div class="modal-card" role="dialog" aria-modal="true"
        aria-labelledby="paid-modal-title">
        <h2 id="paid-modal-title">Paid inference</h2>
        <p id="paid-modal-label"></p>
        <p class="modal-q">Approve paid inference for this run?</p>
        <div class="modal-actions">
          <button type="button" id="paid-cancel">Cancel</button>
          <button type="button" id="paid-approve" class="primary">Approve</button>
        </div>
      </div>
    </div>

    <script type="module">
      // Strip any residual query string from the address bar (e.g. a
      // ?prompt=... left by a pre-JS GET submit) so prompt text never lingers in
      // the URL or history. Live submits are intercepted (preventDefault), so
      // this just cleans up the leak's footprint and any future accidental GET.
      if (location.search) {
        history.replaceState(null, "", location.pathname);
      }

      const form = document.querySelector("#turn-form");
      const promptInput = document.querySelector("#prompt");
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

      const workList = document.querySelector("#work-list");
      const newSessionButton = document.querySelector("#new-session");
      const modelSelect = document.querySelector("#model-id");
      const capFilter = document.querySelector("#cap-filter");
      const tierSelect = document.querySelector("#tier");
      const hintSelect = document.querySelector("#hint");
      const sessionBudgetInput = document.querySelector("#budget-session");
      const perCallBudgetInput = document.querySelector("#budget-per-call");
      const paidModal = document.querySelector("#paid-modal");
      const paidModalLabel = document.querySelector("#paid-modal-label");
      const paidApproveButton = document.querySelector("#paid-approve");
      const paidCancelButton = document.querySelector("#paid-cancel");
      let allModels = [];

      let events = [];
      let selectedEventIndex = -1;
      let currentSessionId = null;
      let sessionGroups = [];
      const SESSION_POINTER = "dyfj-workbench-session";

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

      newSessionButton.addEventListener("click", startNewSession);
      capFilter.addEventListener("change", renderModelOptions);
      modelSelect.addEventListener("change", updateRoutingCascade);
      tierSelect.addEventListener("change", updateRoutingCascade);
      loadModelsIntoPicker();
      updateRoutingCascade();

      // Resume across restarts: load the project-grouped session list, then
      // reopen the last session if it still exists (events come from Dolt, only
      // the pointer is held client-side).
      (async function initWorkbench() {
        await loadSessions();
        const pointer = readSessionPointer();
        if (!pointer) return;
        const exists = sessionGroups.some((group) =>
          (group.sessions ?? []).some((s) => s.sessionId === pointer)
        );
        if (exists) await selectSession(pointer);
      })();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError();

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
        // Resume into the open session; omitting sessionId starts a fresh one.
        if (currentSessionId) body.sessionId = currentSessionId;
        // optional per-turn budget override (honored loopback-only
        // server-side).
        const budgetOverride = readBudgetOverride();
        if (budgetOverride) body.budget = budgetOverride;

        // a paid (T1/T2) selection requires explicit per-turn approval.
        // Confirm before spending; cancelling aborts the turn entirely.
        if (isPaidRiskSelection()) {
          const approved = await confirmPaidInference(paidRiskLabel());
          if (!approved) return;
          body.approvePaidInference = true;
        }

        setBusy(true);
        try {
          const response = await fetch("/api/turn", {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok) {
            if (response.status === 401) showKeyBar();
            throw new Error(payload.error ?? "request failed");
          }
          renderTurn(payload);
          // Clear the prompt only on a successful turn (a failed turn keeps the
          // text so the operator can retry).
          promptInput.value = "";
          // The session list and timeline render from Dolt truth, not the turn
          // payload: adopt the (possibly newly created) session and reload its
          // full persisted event history.
          if (payload.sessionId) {
            currentSessionId = payload.sessionId;
            persistSessionPointer(currentSessionId);
            await loadSessions();
            await loadSessionEvents(currentSessionId);
          }
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      });

      function renderTurn(payload) {
        responseText.classList.remove("empty");
        responseText.textContent = payload.text || "";
        renderFacts(payload);
      }

      function authHeaders(extra) {
        const headers = Object.assign({}, extra);
        const apiKey = storedApiKey();
        if (apiKey !== "") headers["authorization"] = "Bearer " + apiKey;
        return headers;
      }

      async function apiGet(path) {
        const response = await fetch(path, { headers: authHeaders() });
        const payload = await response.json();
        if (!response.ok) {
          if (response.status === 401) showKeyBar();
          throw new Error(payload.error ?? "request failed");
        }
        return payload;
      }

      async function loadSessions() {
        try {
          const payload = await apiGet("/api/sessions");
          sessionGroups = Array.isArray(payload.projects) ? payload.projects : [];
          renderSessions();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      }

      function renderSessions() {
        workList.replaceChildren();
        const total = sessionGroups.reduce(
          (n, group) => n + (group.sessions ? group.sessions.length : 0),
          0,
        );
        if (total === 0) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = "No sessions yet.";
          workList.append(empty);
          return;
        }
        for (const group of sessionGroups) {
          const label = document.createElement("div");
          label.className = "work-group-label";
          label.textContent = group.project || "(no project)";
          workList.append(label);
          for (const session of group.sessions ?? []) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "session-item";
            if (session.sessionId === currentSessionId) {
              item.setAttribute("aria-current", "true");
            }
            // Lead with the distinguishing text (the task / first prompt); the
            // sessionName is almost always a generic constant, so it would make
            // the list a wall of identical titles. Short id as the subtitle for
            // disambiguation + cross-referencing with the event endpoint.
            const title = document.createElement("strong");
            title.textContent = session.taskDescription || session.sessionName ||
              session.slug || session.sessionId;
            const sub = document.createElement("small");
            sub.textContent = session.sessionId.slice(-8);
            item.append(title, sub);
            item.addEventListener("click", () => {
              selectSession(session.sessionId);
            });
            workList.append(item);
          }
        }
      }

      async function loadSessionEvents(sessionId) {
        const payload = await apiGet(
          "/api/sessions/" + encodeURIComponent(sessionId) + "/events",
        );
        events = Array.isArray(payload.events) ? payload.events : [];
        selectedEventIndex = events.length > 0 ? events.length - 1 : -1;
        renderTimeline();
        renderInspector();
      }

      async function selectSession(sessionId) {
        try {
          currentSessionId = sessionId;
          persistSessionPointer(sessionId);
          renderSessions();
          await loadSessionEvents(sessionId);
          facts.session.textContent = sessionId;
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      }

      async function loadModelsIntoPicker() {
        try {
          const payload = await apiGet("/api/models");
          const models = Array.isArray(payload.models) ? payload.models : [];
          // Local-first ordering: tier ascending, then input cost ascending.
          models.sort((a, b) => (a.tier - b.tier) || (a.costInput - b.costInput));
          allModels = models;
          renderModelOptions();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      }

      function renderModelOptions() {
        const cap = capFilter.value;
        const previous = modelSelect.value;
        const visible = cap
          ? allModels.filter((m) => (m.capabilities || []).includes(cap))
          : allModels;
        modelSelect.replaceChildren();
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "Auto (smart routing)";
        modelSelect.append(auto);
        for (const m of visible) {
          const opt = document.createElement("option");
          opt.value = m.slug;
          opt.textContent = m.displayName + " · T" + m.tier + " · " +
            m.provider + " · " + modelCostLabel(m);
          // Server says this row cannot route (unpriced paid model): show it,
          // but don't let it be picked only to fail at selection.
          if (m.routable === false) opt.disabled = true;
          modelSelect.append(opt);
        }
        // Preserve the prior choice if it still passes the filter; otherwise fall
        // back to Auto. Then re-evaluate the cascade.
        modelSelect.value = visible.some((m) => m.slug === previous)
          ? previous
          : "";
        updateRoutingCascade();
      }

      function modelCostLabel(m) {
        // A paid row without prices is unpriced, never "free" — the server's
        // routable flag is authoritative and such a model will not route.
        if (m.routable === false) return "unpriced — not routable";
        if (m.tier === 0) return "free";
        return "$" + m.costInput + "/" + m.costOutput;
      }

      // Make the modelId > tier > hint precedence (selectWorkbenchModel) legible:
      // a chosen model disables Tier + Hint; a chosen Tier disables Hint. Disabled
      // controls are omitted from FormData, so only the effective field is sent.
      function updateRoutingCascade() {
        const modelChosen = modelSelect.value !== "";
        tierSelect.disabled = modelChosen;
        const tierChosen = !modelChosen && tierSelect.value !== "";
        hintSelect.disabled = modelChosen || tierChosen;
      }

      function readBudgetOverride() {
        const out = {};
        const session = parseFloat(sessionBudgetInput.value);
        const perCall = parseFloat(perCallBudgetInput.value);
        if (Number.isFinite(session) && session > 0) out.sessionLimitUsd = session;
        if (Number.isFinite(perCall) && perCall > 0) out.perCallLimitUsd = perCall;
        return Object.keys(out).length > 0 ? out : null;
      }

      function selectedModel() {
        return modelSelect.value
          ? allModels.find((m) => m.slug === modelSelect.value) ?? null
          : null;
      }

      // A turn risks paid inference when a specific paid model is chosen, or when
      // Auto routing is pinned to a paid tier (1 or 2).
      function isPaidRiskSelection() {
        const m = selectedModel();
        if (m) return m.tier > 0;
        return !tierSelect.disabled &&
          (tierSelect.value === "1" || tierSelect.value === "2");
      }

      function paidRiskLabel() {
        const m = selectedModel();
        if (m) return m.displayName + " · " + modelCostLabel(m) + " per Mtok";
        return "a Tier " + tierSelect.value + " (paid) model";
      }

      // Promise-based paid-inference confirm: resolves true on Approve, false on
      // Cancel. The request carries approvePaidInference only when this resolves
      // true — and the server still requires the loopback transport on top.
      function confirmPaidInference(label) {
        return new Promise((resolve) => {
          paidModalLabel.textContent = label;
          paidModal.hidden = false;
          paidApproveButton.focus();
          const finish = (ok) => {
            paidModal.hidden = true;
            paidApproveButton.removeEventListener("click", onApprove);
            paidCancelButton.removeEventListener("click", onCancel);
            resolve(ok);
          };
          const onApprove = () => finish(true);
          const onCancel = () => finish(false);
          paidApproveButton.addEventListener("click", onApprove);
          paidCancelButton.addEventListener("click", onCancel);
        });
      }

      function startNewSession() {
        currentSessionId = null;
        persistSessionPointer(null);
        promptInput.value = "";
        events = [];
        selectedEventIndex = -1;
        responseText.classList.add("empty");
        responseText.textContent = "No turn yet.";
        clearFacts();
        renderTimeline();
        renderInspector();
        renderSessions();
      }

      function clearFacts() {
        for (const el of Object.values(facts)) el.textContent = "-";
        facts.cost.classList.remove("cost-paid");
      }

      function persistSessionPointer(sessionId) {
        try {
          if (sessionId) localStorage.setItem(SESSION_POINTER, sessionId);
          else localStorage.removeItem(SESSION_POINTER);
        } catch {
          /* a browser that refuses storage just loses cross-reload resume */
        }
      }

      function readSessionPointer() {
        try {
          return localStorage.getItem(SESSION_POINTER) ?? "";
        } catch {
          return "";
        }
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
          name.textContent = event.eventType ?? event.type ?? "event";
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
          ? rows.join("\\n")
          : "(empty event)";
      }

      function summarizeEvent(event) {
        if (!event || typeof event !== "object") return "";
        // Dolt WorkbenchSessionEvent shape (events render from Dolt truth).
        if (event.toolName) {
          return [event.toolName, snippet(event.toolResult)].filter(Boolean)
            .join(" → ");
        }
        if (event.modelId) return event.modelId;
        if (event.content) return snippet(event.content);
        if (event.stopReason) return event.stopReason;
        return event.createdAt ?? "";
      }

      function snippet(value) {
        if (value === null || value === undefined) return "";
        const text = String(value).replace(/\\s+/g, " ").trim();
        return text.length > 56 ? text.slice(0, 55) + "…" : text;
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
  const engineConfig = await loadConfig();
  // Resolve declared secret pointers into the process env before serving, so a
  // paid turn finds its provider key. env wins; presence-only; a locked pointer
  // degrades that provider fail-closed. No-op without a [secrets] section.
  await resolveSecretsIntoEnv(await loadSecretsConfig());
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
    engineConfig,
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
