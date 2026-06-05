import {
  runWorkbenchRuntime,
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
      return await handleJsonTurn(request, runRuntime);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
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
    const result = await runRuntime({
      ...runtimeInput,
      confirmPaidEscalation: async () => {
        throw new Error("paid inference requires an explicit CLI consent flow");
      },
    });
    return jsonResponse(result);
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
    <title>DYFJ Workbench</title>
  </head>
  <body>
    <main>
      <h1>DYFJ Workbench</h1>
      <form method="post" action="/api/turn">
        <label for="prompt">Prompt</label>
        <textarea id="prompt" name="prompt" rows="8" cols="72"></textarea>
        <button type="submit">Run</button>
      </form>
      <p>JSON endpoint: <code>POST /api/turn</code></p>
    </main>
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
