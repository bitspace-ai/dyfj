/**
 * A headless host calls the native turn runtime directly. These component
 * tests use only the engine ports and in-repo fakes: no CLI, socket server,
 * Kubernetes, model service, or operator corpus is involved.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { spy } from "@std/testing/mock";
import {
  chatReply,
  engineServices,
  eventRows,
  LOCAL_MODEL,
  systemMessage,
  tempWorkspace,
} from "../../testing/builders/engine.ts";
import type {
  WorkbenchAuthContext,
  WorkbenchRuntimeEvent,
} from "../contract/mod.ts";
import type { MemorySeed } from "../store/mod.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";

const HEADLESS_AUTH: WorkbenchAuthContext = {
  transport: "remote",
  authnStatus: "authenticated",
  authnMechanism: "api_key",
  authnIssuerRef: "fixture-headless-host",
  authzBasis: "scheduled-task",
};

function contextFor(host: string): MemorySeed {
  return {
    memory_id: `context-${host}`,
    slug: `context-${host}`,
    type: "user",
    visibility: "client_safe",
    inject: "always",
    name: `Context ${host}`,
    description: `Synthetic context for ${host}`,
    content: `Synthetic context belongs to ${host} only.`,
  };
}

Deno.test("two headless hosts complete native turns with separate context, identity and event stores", async () => {
  await using rootA = await tempWorkspace();
  await using rootB = await tempWorkspace();
  const hostA = engineServices([chatReply({ content: "A complete" })], {
    memories: [contextFor("a")],
    env: {},
  });
  const hostB = engineServices([chatReply({ content: "B complete" })], {
    memories: [contextFor("b")],
    env: {},
  });
  const eventsA: WorkbenchRuntimeEvent[] = [];
  const eventsB: WorkbenchRuntimeEvent[] = [];
  const commitsA = spy(hostA.store.journal, "commit");
  const commitsB = spy(hostB.store.journal, "commit");

  const runHost = (
    host: typeof hostA,
    principalId: string,
    rootOverride: string,
    events: WorkbenchRuntimeEvent[],
  ) =>
    runWorkbenchRuntime({
      mode: "turn",
      prompt: "Complete the scheduled task",
      routingOptions: { modelId: LOCAL_MODEL.slug },
      defaultCompanionModel: LOCAL_MODEL.slug,
      principalId,
      authContext: HEADLESS_AUTH,
      rootOverride,
      permissionLevel: "strict",
      frames: { onRuntimeEvent: (event) => void events.push(event) },
    }, host.services);

  const a = await runHost(hostA, "bot-a", rootA.root, eventsA);
  const b = await runHost(hostB, "bot-b", rootB.root, eventsB);
  hostA.transport.assertDone();
  hostB.transport.assertDone();
  assertEquals([a.text, b.text], ["A complete", "B complete"]);
  assertEquals([a.stopReason, b.stopReason], ["stop", "stop"]);
  assertEquals([a.tokens.totalCalls, b.tokens.totalCalls], [1, 1]);
  assertEquals(eventsA.at(-1)?.type, "turnCompleted");
  assertEquals(eventsB.at(-1)?.type, "turnCompleted");

  const promptA = systemMessage(hostA.transport.requests[0]);
  const promptB = systemMessage(hostB.transport.requests[0]);
  assertStringIncludes(promptA, "Synthetic context belongs to a only.");
  assertStringIncludes(promptB, "Synthetic context belongs to b only.");
  assertEquals(
    JSON.stringify(hostA.transport.requests).includes("belongs to b only"),
    false,
  );
  assertEquals(
    JSON.stringify(hostB.transport.requests).includes("belongs to a only"),
    false,
  );

  const rowsA = await eventRows(hostA, a.sessionId);
  const rowsB = await eventRows(hostB, b.sessionId);
  const writtenA = commitsA.calls.flatMap((call) => call.args[0].events);
  const writtenB = commitsB.calls.flatMap((call) => call.args[0].events);
  commitsA.restore();
  commitsB.restore();
  assert(a.sessionId !== b.sessionId);
  for (
    const [rows, written, principal] of [
      [rowsA, writtenA, "bot-a"],
      [rowsB, writtenB, "bot-b"],
    ] as const
  ) {
    const start = rows.find((row) => row.event_type === "session_start");
    assert(start !== undefined);
    assertEquals(start.principal_id, principal);
    const committedStart = written.find((event) =>
      event.event_type === "session_start"
    );
    assert(committedStart !== undefined);
    assertEquals(committedStart.authn_issuer_ref, "fixture-headless-host");
    assertEquals(committedStart.authz_basis, "scheduled-task");
    assert(rows.some((row) => row.event_type === "provider_call"));
    assert(rows.some((row) => row.event_type === "model_response"));
    assert(rows.some((row) => row.event_type === "session_end"));
    // The legacy model_selected event has a separately documented identity gap.
    assert(
      rows.filter((row) => row.event_type !== "model_selected").every(
        (row) => row.principal_id === principal,
      ),
    );
  }
  assertEquals(await eventRows(hostA, b.sessionId), []);
  assertEquals(await eventRows(hostB, a.sessionId), []);
});

Deno.test("a headless host without an approval handler denies a model-requested mutation", async () => {
  await using root = await tempWorkspace();
  const host = engineServices([
    chatReply({
      toolCalls: [{
        id: "attempt-write",
        name: "write_file",
        arguments: { path: "note.txt", content: "must not be written" },
      }],
    }),
    chatReply({ content: "Task ended without writing" }),
  ], { memories: [contextFor("denied")], env: {} });
  const commits = spy(host.store.journal, "commit");
  const result = await runWorkbenchRuntime({
    mode: "turn",
    prompt: "Try to write a note",
    routingOptions: { modelId: LOCAL_MODEL.slug },
    defaultCompanionModel: LOCAL_MODEL.slug,
    principalId: "bot-denied",
    authContext: HEADLESS_AUTH,
    rootOverride: root.root,
    permissionLevel: "strict",
    // No approver: the engine's existing policy must deny the mutation.
  }, host.services);

  host.transport.assertDone();
  assertEquals(result.text, "Task ended without writing");
  assertEquals(result.agent.toolStepsUsed, 1);
  await assertRejects(
    () => Deno.stat(`${root.root}/note.txt`),
    Deno.errors.NotFound,
  );
  const attempted = (await eventRows(host, result.sessionId)).find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "attempt-write"
  );
  const committedAttempt = commits.calls.flatMap((call) => call.args[0].events)
    .find((event) =>
      event.event_type === "tool_call" && event.tool_call_id === "attempt-write"
    );
  commits.restore();
  assertEquals(attempted?.tool_is_error, "1");
  assertEquals(committedAttempt?.action, "deny");
  assertStringIncludes(attempted?.tool_result ?? "", "approval is unavailable");
});
