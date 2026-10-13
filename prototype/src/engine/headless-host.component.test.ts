/**
 * A headless host calls the native turn runtime directly. These component
 * tests use only the engine ports and in-repo fakes: no CLI, socket server,
 * Kubernetes, model service, or operator corpus is involved.
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mock } from "node:test";
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
  const commitsA = mock.method(hostA.store.journal, "commit");
  const commitsB = mock.method(hostB.store.journal, "commit");

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
  assert.deepStrictEqual([a.text, b.text], ["A complete", "B complete"]);
  assert.deepStrictEqual([a.stopReason, b.stopReason], ["stop", "stop"]);
  assert.deepStrictEqual([a.tokens.totalCalls, b.tokens.totalCalls], [1, 1]);
  assert.deepStrictEqual(eventsA.at(-1)?.type, "turnCompleted");
  assert.deepStrictEqual(eventsB.at(-1)?.type, "turnCompleted");

  const promptA = systemMessage(hostA.transport.requests[0]);
  const promptB = systemMessage(hostB.transport.requests[0]);
  assert.ok(promptA.includes("Synthetic context belongs to a only."), `expected ${JSON.stringify(promptA)} to include "Synthetic context belongs to a only."`);
  assert.ok(promptB.includes("Synthetic context belongs to b only."), `expected ${JSON.stringify(promptB)} to include "Synthetic context belongs to b only."`);
  assert.deepStrictEqual(
    JSON.stringify(hostA.transport.requests).includes("belongs to b only"),
    false,
  );
  assert.deepStrictEqual(
    JSON.stringify(hostB.transport.requests).includes("belongs to a only"),
    false,
  );

  const rowsA = await eventRows(hostA, a.sessionId);
  const rowsB = await eventRows(hostB, b.sessionId);
  const writtenA = commitsA.calls.flatMap((call) => call.args[0].events);
  const writtenB = commitsB.calls.flatMap((call) => call.args[0].events);
  commitsA.mock.restore();
  commitsB.mock.restore();
  assert.ok(a.sessionId !== b.sessionId);
  for (
    const [rows, written, principal] of [
      [rowsA, writtenA, "bot-a"],
      [rowsB, writtenB, "bot-b"],
    ] as const
  ) {
    const start = rows.find((row) => row.event_type === "session_start");
    assert.ok(start !== undefined);
    assert.deepStrictEqual(start.principal_id, principal);
    const committedStart = written.find((event) =>
      event.event_type === "session_start"
    );
    assert.ok(committedStart !== undefined);
    assert.deepStrictEqual(committedStart.authn_status, "authenticated");
    assert.deepStrictEqual(committedStart.authn_mechanism, "api_key");
    assert.deepStrictEqual(committedStart.authn_issuer_ref, "fixture-headless-host");
    assert.deepStrictEqual(committedStart.authz_basis, "scheduled-task");
    assert.ok(rows.some((row) => row.event_type === "provider_call"));
    assert.ok(rows.some((row) => row.event_type === "model_response"));
    assert.ok(rows.some((row) => row.event_type === "session_end"));
    // The legacy model_selected event has a separately documented identity gap.
    assert.ok(
      rows.filter((row) => row.event_type !== "model_selected").every(
        (row) => row.principal_id === principal,
      ),
    );
  }
  assert.deepStrictEqual(await eventRows(hostA, b.sessionId), []);
  assert.deepStrictEqual(await eventRows(hostB, a.sessionId), []);
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
  const commits = mock.method(host.store.journal, "commit");
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
  assert.deepStrictEqual(result.text, "Task ended without writing");
  assert.deepStrictEqual(result.agent.toolStepsUsed, 1);
  await assert.rejects(
    () => stat(`${root.root}/note.txt`),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ENOENT",
  );
  const attempted = (await eventRows(host, result.sessionId)).find((row) =>
    row.event_type === "tool_call" && row.tool_call_id === "attempt-write"
  );
  const committedAttempt = commits.calls.flatMap((call) => call.args[0].events)
    .find((event) =>
      event.event_type === "tool_call" && event.tool_call_id === "attempt-write"
    );
  commits.mock.restore();
  assert.deepStrictEqual(attempted?.tool_is_error, "1");
  assert.deepStrictEqual(committedAttempt?.action, "deny");
  assert.ok((attempted?.tool_result ?? "").includes("approval is unavailable"), `expected attempted?.tool_result ?? "" to include "approval is unavailable"`);
});
