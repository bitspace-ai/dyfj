import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { AcpSessionHandleMap, canonicalResumeDigest } from "./acp-session-map.ts";
import { type AcpExecutionProfile, startAcpSession } from "./acp-client.ts";
import { fixtureAgentCommand } from "./acp-fixture-command.ts";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import { MemoryStore, fetchWorkbenchSessionEvents } from "./store/mod.ts";
import { buildConversationMessages } from "./context/mod.ts";

async function setup(mode = "normal") {
  const logs = resolve(import.meta.dirname!, "../../logs");
  await mkdir(logs, { recursive: true });
  const directory = await mkdtemp(join(logs, "durable-resume-"));
  const methodLog = join(directory, "methods.log");
  await writeFile(methodLog, "");
  const profile: AcpExecutionProfile = {
    slug: "fixture", ...fixtureAgentCommand({ scriptArgs: [`--method-log=${methodLog}`] }),
    workspace: directory, transport: "local_stdio", accessRoute: "local_sidecar", costBasis: "local_free",
    environment: { ACP_FIXTURE_MODE: mode, ACP_FIXTURE_HISTORY_FILE: join(directory, "history.jsonl"),
      CODEX_CONFIG: JSON.stringify({ model: "model-a", model_reasoning_effort: "medium" }) },
  };
  return { profile, methodLog };
}

it("restart with unchanged profile loads and verifies without session/new; replay never reaches frames, evidence or journal", async () => {
  const { profile, methodLog } = await setup();
  const store = new MemoryStore();
  let map = new AcpSessionHandleMap();
  const run = (input: Partial<Parameters<typeof runExternalAgentWorkbenchRuntime>[0]> = {}) =>
    runExternalAgentWorkbenchRuntime({ mode: "turn", prompt: "first turn", routingOptions: {},
      runner: { kind: "acp", profile: "fixture" }, workspaceRoot: profile.workspace, ...input },
    { store, sessionMap: map, resolveProfile: () => profile });
  try {
    const first = await run();
    const second = await run({ sessionId: first.sessionId, prompt: "second turn" });
    const events = await fetchWorkbenchSessionEvents({ sessionId: first.sessionId, events: store.events });
    const latest = events.filter((event) => event.eventType === "agent_response").at(-1)!;
    assert.equal(latest.runnerResumeDigest, canonicalResumeDigest(profile));
    await map.shutdown();
    map = new AcpSessionHandleMap();
    await writeFile(methodLog, "");
    const rendered: string[] = [];
    const frames: unknown[] = [];
    const third = await run({ sessionId: first.sessionId, prompt: "FIXTURE_PREVIOUS_REPLY",
      conversationMessages: buildConversationMessages(events),
      latestAgentResponse: { externalSessionId: latest.runnerExternalSessionId,
        resumeDigest: latest.runnerResumeDigest!, content: latest.content },
      frames: { onTextDelta: (text) => { rendered.push(text); }, onRuntimeEvent: (event) => { frames.push(event); } },
    });
    assert.equal(third.text, second.text);
    assert.equal(third.runner.continuity?.state, "durably-resumed");
    assert.equal(third.runner.continuity?.durableResume, "verified");
    assert.equal(rendered.join(""), third.text);
    assert.ok(!JSON.stringify(frames).includes("replay-only"));
    assert.ok(!JSON.stringify(frames).includes("continuityReconstructing"));
    assert.equal(third.runner.toolEvidence.observedCalls, 0);
    const after = await fetchWorkbenchSessionEvents({ sessionId: first.sessionId, events: store.events });
    assert.equal(after.filter((event) => event.eventType === "agent_response").length, 3);
    assert.ok(!JSON.stringify(after).includes("replay-only"));
    const methods = (await readFile(methodLog, "utf8")).trim().split("\n");
    assert.deepEqual(methods, ["initialize", "session/load", "session/prompt"]);
  } finally { await map.shutdown(); await store.close(); }
});

for (const mode of ["load_mismatch", "load_bound", "load_bytes", "load_error", "load_oversize", "load_timeout"]) {
  it(`${mode}: reconstructs with durable_resume_failed and the turn succeeds`, async () => {
    const { profile, methodLog } = await setup(mode);
    let map = new AcpSessionHandleMap();
    try {
      const first = await map.runTurn({ sessionId: "test", workspace: profile.workspace, profile, prompt: "first" });
      await map.shutdown();
      map = new AcpSessionHandleMap();
      await writeFile(methodLog, "");
      let reason: unknown;
      let state: unknown;
      const result = await map.runTurn({ sessionId: "test", workspace: profile.workspace, profile,
        prompt: "follow-up", reconstructPrompt: () => "reconstructed follow-up",
        latestAgentResponse: { externalSessionId: first.externalSessionId!, content: first.text,
          resumeDigest: canonicalResumeDigest(profile) },
        onContinuity: (evidence, value) => { state = evidence.state; reason = value; },
      });
      assert.equal(result.stopReason, "stop");
      assert.equal(state, "reconstructed");
      assert.equal(reason, "durable_resume_failed");
      const methods = await readFile(methodLog, "utf8");
      assert.ok(methods.includes("session/load\n"));
      assert.ok(methods.includes("session/new\n"));
    } finally { await map.shutdown(); }
  });
}

for (const change of ["model", "effort", "missing-id", "missing-digest", "empty-content", "no-load-capability"]) {
  it(`${change}: reconstructs with the existing reason and sends no session/load`, async () => {
    const { profile, methodLog } = await setup();
    if (change === "no-load-capability") profile.environment.ACP_FIXTURE_LOAD_SESSION = "no";
    const map = new AcpSessionHandleMap();
    const digest = canonicalResumeDigest(profile);
    if (change === "model" || change === "effort") {
      profile.environment.CODEX_CONFIG = JSON.stringify({ model: change === "model" ? "model-b" : "model-a",
        model_reasoning_effort: change === "effort" ? "high" : "medium" });
    }
    try {
      let reason: unknown;
      let state: unknown;
      const result = await map.runTurn({ sessionId: "test", workspace: profile.workspace, profile,
        prompt: "follow-up", reconstructPrompt: () => "reconstructed follow-up",
        latestAgentResponse: { externalSessionId: change === "missing-id" ? null : "previous",
          resumeDigest: change === "missing-digest" ? null : digest,
          content: change === "empty-content" ? "" : "previous reply" },
        onContinuity: (evidence, value) => { state = evidence.state; reason = value; },
      });
      assert.equal(result.stopReason, "stop");
      assert.equal(state, "reconstructed");
      assert.equal(reason, "not_held");
      assert.ok(!(await readFile(methodLog, "utf8")).includes("session/load"));
    } finally { await map.shutdown(); }
  });
}

it("loaded replay has separate budgets and reports bounded replay statistics", async () => {
  const { profile } = await setup();
  const first = await startAcpSession({ profile });
  let candidate;
  try { candidate = await first.prompt({ prompt: "first" }); } finally { await first.close(); }
  const path = profile.environment.ACP_FIXTURE_HISTORY_FILE;
  const history = await readFile(path, "utf8");
  const older = JSON.stringify({ sessionId: candidate.externalSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(100) } } }) + "\n";
  await writeFile(path, older.repeat(1_025) + history);
  const loaded = await startAcpSession({ profile, resumeCandidate: { externalSessionId: candidate.externalSessionId!, content: candidate.text } });
  try {
    assert.equal(loaded.replayStats?.updates, 1_030);
    assert.ok(loaded.replayStats!.bytes > candidate.text.length);
    assert.ok(loaded.replayStats!.elapsedMs >= 0);
    assert.equal((await loaded.prompt({ prompt: "next" })).stopReason, "stop");
  } finally { await loaded.close(); }
});

it("session/load preserves the additional directories supplied to session/new", async () => {
  const { profile } = await setup();
  profile.additionalDirectories = [profile.workspace];
  profile.environment.ACP_FIXTURE_ADDITIONAL_DIRECTORIES = "yes";
  const first = await startAcpSession({ profile });
  let candidate;
  try { candidate = await first.prompt({ prompt: "first" }); } finally { await first.close(); }
  const loaded = await startAcpSession({ profile, resumeCandidate: { externalSessionId: candidate.externalSessionId!, content: candidate.text } });
  try {
    assert.equal(loaded.verifiedResumedExternalSessionId, candidate.externalSessionId);
    assert.ok((await loaded.prompt({ prompt: "next" })).text.includes(`dirs=${profile.workspace}|`));
  } finally { await loaded.close(); }
});
