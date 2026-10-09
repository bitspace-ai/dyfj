/**
 * A resumed session comes back on the model it last ran on (integration).
 *
 * The real engine runs behind the real UDS seam, over the in-repo store fake
 * and a scripted provider transport. Each turn records the model it routed to
 * as a `model_selected` event; a later turn that names the session and no
 * model of its own routes to that model, and `sessions/inspect` reports it.
 * A recorded model that is no longer routable refuses the turn before any
 * provider call, instead of falling back to the configured default.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  chatReply,
  type EngineRun,
  engineServices,
  LOCAL_MODEL,
} from "../../testing/builders/engine.ts";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import { runWorkbenchRuntime } from "../engine/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import { createWorkbenchSession, modelSelectedEvent } from "../store/mod.ts";
import { connectUnixClient } from "../transport/mod.ts";
import { serveWorkbenchUnix } from "./main.ts";

/** A second free local model, so "resumed on the default" is observable. */
const OTHER_MODEL: ModelSeed = {
  ...LOCAL_MODEL,
  slug: "local-other",
  display_name: "Local Other",
};

/** A catalog row the operator has since deactivated. */
const RETIRED_MODEL: ModelSeed = {
  ...LOCAL_MODEL,
  slug: "local-retired",
  display_name: "Local Retired",
  active: false,
};

interface TurnReply {
  sessionId: string;
  model: { slug: string };
  route: { reason: string };
}

async function withServer(
  run: EngineRun,
  body: (
    client: Awaited<ReturnType<typeof connectUnixClient>>,
  ) => Promise<void>,
): Promise<void> {
  const socketPath = udsTestSocket("server-session-model");
  await Deno.remove(socketPath).catch(() => {});
  const server = await serveWorkbenchUnix(socketPath, {
    store: run.store,
    env: run.env,
    // The configured default: what a resumed session fell back to before.
    defaultCompanionModel: LOCAL_MODEL.slug,
    runRuntime: (input) => runWorkbenchRuntime(input, run.services),
  });
  try {
    const client = await connectUnixClient(server.socketPath);
    try {
      await body(client);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
    await Deno.remove(socketPath).catch(() => {});
  }
}

Deno.test("a resumed session runs on the model it last ran on, not the configured default", async () => {
  const run = engineServices(
    [chatReply({ content: "first" }), chatReply({ content: "second" })],
    { models: [LOCAL_MODEL, OTHER_MODEL] },
  );
  await withServer(run, async (client) => {
    const first = await client.request("turn", {
      prompt: "start on the other model",
      routingOptions: { modelId: OTHER_MODEL.slug },
    }) as TurnReply;
    assertEquals(first.model.slug, OTHER_MODEL.slug);

    const inspected = await client.request("sessions/inspect", {
      sessionId: first.sessionId,
    }) as { model: string | null };
    assertEquals(inspected.model, OTHER_MODEL.slug);

    // A new connection, as a restarted client would make, naming only the
    // session: no model of its own.
    const resumed = await client.request("turn", {
      prompt: "carry on",
      sessionId: first.sessionId,
    }) as TurnReply;
    assertEquals(resumed.model.slug, OTHER_MODEL.slug);
    assertEquals(resumed.route.reason, "session_model");
  });
});

Deno.test("an explicit model on a resumed turn still wins over the recorded one", async () => {
  const run = engineServices(
    [chatReply({ content: "first" }), chatReply({ content: "second" })],
    { models: [LOCAL_MODEL, OTHER_MODEL] },
  );
  await withServer(run, async (client) => {
    const first = await client.request("turn", {
      prompt: "start",
      routingOptions: { modelId: OTHER_MODEL.slug },
    }) as TurnReply;
    const resumed = await client.request("turn", {
      prompt: "switch",
      sessionId: first.sessionId,
      routingOptions: { modelId: LOCAL_MODEL.slug },
    }) as TurnReply;
    assertEquals(resumed.model.slug, LOCAL_MODEL.slug);
    const inspected = await client.request("sessions/inspect", {
      sessionId: first.sessionId,
    }) as { model: string | null };
    assertEquals(
      inspected.model,
      LOCAL_MODEL.slug,
      "the latest turn's model is the recorded one",
    );
  });
});

Deno.test("a resumed session whose recorded model is no longer routable refuses before any provider call", async () => {
  const run = engineServices([], {
    models: [LOCAL_MODEL, RETIRED_MODEL],
  });
  const sessionId = "01TEST0000000000000000RETD";
  await createWorkbenchSession({
    journal: run.store.journal,
    sessionId,
    slug: "workbench-retired",
    taskDescription: "earlier",
    content: "{}",
  });
  await run.store.journal.commit({
    events: [modelSelectedEvent({
      event_id: "01TEST0000000000000000EVT1",
      session_id: sessionId,
      trace_id: "trace-retired",
      span_id: "span-retired",
      principal_id: "user",
      principal_type: "human",
      action: "select",
      resource: RETIRED_MODEL.slug,
      authz_basis: "routing_heuristic",
      model_id: RETIRED_MODEL.slug,
      content: "{}",
    })],
  });
  await withServer(run, async (client) => {
    const error = await assertRejects(() =>
      client.request("turn", { prompt: "carry on", sessionId })
    );
    assert(error instanceof Error);
    assertStringIncludes(error.message, RETIRED_MODEL.slug);
    assertStringIncludes(error.message, "no longer routable");
  });
  assertEquals(run.transport.requests.length, 0, "no provider call was made");
});

Deno.test("a resumed session with no recorded model runs on the configured default", async () => {
  const run = engineServices([chatReply({ content: "ok" })], {
    models: [LOCAL_MODEL, OTHER_MODEL],
  });
  const sessionId = "01TEST0000000000000000NXNE";
  await createWorkbenchSession({
    journal: run.store.journal,
    sessionId,
    slug: "workbench-none",
    taskDescription: "earlier",
    content: "{}",
  });
  await withServer(run, async (client) => {
    const inspected = await client.request("sessions/inspect", {
      sessionId,
    }) as { model: string | null };
    assertEquals(inspected.model, null);
    const resumed = await client.request("turn", {
      prompt: "carry on",
      sessionId,
    }) as TurnReply;
    assertEquals(resumed.model.slug, LOCAL_MODEL.slug);
  });
});
