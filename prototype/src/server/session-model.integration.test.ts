/**
 * A resumed session comes back on the model it last ran on (integration).
 *
 * The real engine runs behind the real UDS seam, over the in-repo store fake
 * and a scripted provider transport. Each provider call is recorded as a
 * `provider_call` event; a later turn that names the session and no model of
 * its own routes to the model of the latest call that completed, and
 * `sessions/inspect` reports it. A model a turn selected but never ran on
 * does not count.
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
import {
  agentResponseEvent,
  createWorkbenchSession,
  providerCallEvent,
} from "../store/mod.ts";
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

/** A model whose window cannot hold even the request prefix. */
const TINY_MODEL: ModelSeed = {
  ...LOCAL_MODEL,
  slug: "local-tiny",
  display_name: "Local Tiny",
  context_window: 64,
  max_output_tokens: 16,
};

// A turn that selects a model and then never runs on it (its provider call
// fails, or its request is refused as too large before it is sent) must not
// become the model the session resumes on.
for (
  const { label, models, failing } of [
    {
      label: "whose provider call failed",
      models: [LOCAL_MODEL, OTHER_MODEL],
      failing: {
        slug: LOCAL_MODEL.slug,
        exchanges: [{ respond: { status: 500, body: "boom" } }],
      },
    },
    {
      label: "refused as too large for its window",
      models: [LOCAL_MODEL, OTHER_MODEL, TINY_MODEL],
      failing: { slug: TINY_MODEL.slug, exchanges: [] },
    },
  ]
) {
  Deno.test(`a resume skips a selected model ${label}`, async () => {
    const run = engineServices(
      [
        chatReply({ content: "first" }),
        ...failing.exchanges,
        chatReply({ content: "third" }),
      ],
      { models },
    );
    await withServer(run, async (client) => {
      const first = await client.request("turn", {
        prompt: "start on the other model",
        routingOptions: { modelId: OTHER_MODEL.slug },
      }) as TurnReply;
      await assertRejects(() =>
        client.request("turn", {
          prompt: "try another model",
          sessionId: first.sessionId,
          routingOptions: { modelId: failing.slug },
        })
      );
      const inspected = await client.request("sessions/inspect", {
        sessionId: first.sessionId,
      }) as { model: string | null };
      assertEquals(inspected.model, OTHER_MODEL.slug);
      const resumed = await client.request("turn", {
        prompt: "carry on",
        sessionId: first.sessionId,
      }) as TurnReply;
      assertEquals(resumed.model.slug, OTHER_MODEL.slug);
    });
  });
}

Deno.test("a bare resume after an external-agent turn refuses instead of routing to the older native model", async () => {
  const run = engineServices(
    [chatReply({ content: "first" }), chatReply({ content: "explicit" })],
    { models: [LOCAL_MODEL, OTHER_MODEL] },
  );
  await withServer(run, async (client) => {
    const first = await client.request("turn", {
      prompt: "start natively",
      routingOptions: { modelId: OTHER_MODEL.slug },
    }) as TurnReply;
    // The external-agent turn that followed, as its runner records it.
    await run.store.journal.commit({
      events: [agentResponseEvent({
        event_id: "01TEST0000000000000000ACP1",
        session_id: first.sessionId,
        trace_id: "trace-acp",
        span_id: "span-acp",
        principal_id: "user",
        principal_type: "agent",
        action: "invoke",
        resource: "fixture",
        authz_basis: "test",
        runner_kind: "external_agent",
        runner_profile: "fixture",
        content: "the runner's reply",
      })],
    });
    const inspected = await client.request("sessions/inspect", {
      sessionId: first.sessionId,
    }) as { model: string | null; runner: string | null };
    assertEquals(inspected, { ...inspected, model: null, runner: "fixture" });
    const error = await assertRejects(() =>
      client.request("turn", { prompt: "carry on", sessionId: first.sessionId })
    );
    assert(error instanceof Error);
    assertStringIncludes(error.message, "external agent runner");
    assertStringIncludes(error.message, "fixture");
    // An explicit model is the operator's choice and still runs.
    const explicit = await client.request("turn", {
      prompt: "carry on here",
      sessionId: first.sessionId,
      routingOptions: { modelId: LOCAL_MODEL.slug },
    }) as TurnReply;
    assertEquals(explicit.model.slug, LOCAL_MODEL.slug);
  });
  assertEquals(
    run.transport.requests.length,
    2,
    "no call for the refused turn",
  );
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
    events: [providerCallEvent({
      event_id: "01TEST0000000000000000EVT1",
      session_id: sessionId,
      trace_id: "trace-retired",
      span_id: "span-retired",
      principal_id: "user",
      principal_type: "agent",
      action: "invoke",
      resource: RETIRED_MODEL.slug,
      authz_basis: "test",
      model_id: RETIRED_MODEL.slug,
      provider_call_order: 1,
      provider_call_purpose: "initial",
      stop_reason: "stop",
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
