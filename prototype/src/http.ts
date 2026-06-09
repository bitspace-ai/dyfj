import {
  runWorkbenchRuntime,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeResult,
} from "./workbench";
import type { WorkbenchRoutingOptions } from "./provider";

export type WorkbenchHttpRuntime = (
  input: WorkbenchRuntimeInput,
) => Promise<WorkbenchRuntimeResult>;

export interface WorkbenchHttpHandlerOptions {
  runRuntime?: WorkbenchHttpRuntime;
}

interface TurnRequestBody {
  prompt?: unknown;
  mode?: unknown;
  routingOptions?: unknown;
}

export function createWorkbenchHttpHandler(
  options: WorkbenchHttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const runRuntime = options.runRuntime ?? runWorkbenchRuntime;
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderWorkbenchIndex());
    }
    if (request.method === "POST" && url.pathname === "/api/turn") {
      const intentError = validateWorkbenchTurnIntent(request, url);
      if (intentError !== undefined) {
        return jsonResponse({ error: intentError }, 403);
      }
      return await handleJsonTurn(request, runRuntime);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

function validateWorkbenchTurnIntent(
  request: Request,
  url: URL,
): string | undefined {
  if (!isLoopbackHost(url.hostname)) {
    return "workbench HTTP API only accepts loopback hosts";
  }

  const host = request.headers.get("host");
  if (host !== null && !isLoopbackHost(parseHostHeader(host))) {
    return "workbench HTTP API only accepts loopback hosts";
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return "content-type must be application/json";
  }

  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return "cross-site workbench turn requests are not allowed";
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return "invalid request origin";
    }
    if (!isLoopbackHost(originUrl.hostname)) {
      return "cross-origin workbench turn requests are not allowed";
    }
  }

  return undefined;
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

async function handleJsonTurn(
  request: Request,
  runRuntime: WorkbenchHttpRuntime,
): Promise<Response> {
  let body: TurnRequestBody;
  try {
    body = await request.json() as TurnRequestBody;
  } catch {
    return jsonResponse({ error: "request body must be JSON" }, 400);
  }

  const runtimeInput = buildRuntimeInputFromJson(body);
  if ("error" in runtimeInput) {
    return jsonResponse({ error: runtimeInput.error }, 400);
  }

  try {
    const events: WorkbenchRuntimeEvent[] = [];
    const result = await runRuntime({
      ...runtimeInput,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      confirmPaidEscalation: () =>
        Promise.reject(
          new Error("paid inference requires an explicit CLI consent flow"),
        ),
    });
    return jsonResponse({ ...result, events });
  } catch (err) {
    return jsonResponse({
      error: (err as Error)?.message ?? String(err),
    }, 500);
  }
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
  return {
    mode,
    prompt: body.prompt,
    routingOptions,
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
          const response = await fetch("/api/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok) {
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
        inspector.textContent = JSON.stringify(event ?? {}, null, 2);
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
        return (tokens.input ?? 0) + " in / " + (tokens.output ?? 0) + " out";
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
  const hostname = Deno.env.get("DYFJ_WORKBENCH_HTTP_HOST") ?? "127.0.0.1";
  Deno.serve({ hostname, port }, createWorkbenchHttpHandler());
}
