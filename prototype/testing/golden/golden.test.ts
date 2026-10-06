/**
 * Golden characterization suite: black-box snapshots of today's observable
 * behavior, pinned for the whole restructuring phase.
 *
 * Every scenario drives the real engine server and CLI as child processes
 * (see harness.ts) and captures what crosses the boundary: stream frames and
 * RPC responses, the rendered CLI output, and every `events`/`sessions` row
 * the scenario wrote (all columns). Captures are normalized (normalize.ts)
 * and compared with the committed snapshot in `snapshots/`.
 *
 * Scenarios run in order against one database and share state on purpose:
 * scenario 5 resumes scenario 1's session, and the read methods in scenario
 * 10 see everything written before them.
 *
 * Update snapshots only as the snapshot rules in `specs/03-testing.md` §4
 * allow:  deno task test:golden --update
 */

import { AssertionError } from "node:assert";
import {
  type ChatMessage,
  type ChatRequest,
  type ModelReply,
} from "../servers/model-server.ts";
import {
  type GoldenModelRow,
  type Harness,
  prototypeRoot,
  startHarness,
} from "./harness.ts";
import { OPERATOR, STRICT } from "./profiles.ts";

const UPDATE = Deno.args.includes("--update");
const SNAPSHOT_DIR = `${prototypeRoot}/testing/golden/snapshots`;

// ── Catalog ─────────────────────────────────────────────────────────────────

const LOCAL = "golden-local";
const PRICED = "golden-priced";
const METERED = "golden-metered";
const SMALL = "golden-small";

const MODELS: GoldenModelRow[] = [
  {
    slug: LOCAL,
    displayName: "Golden Local",
    tier: 0,
    contextWindow: 32768,
    maxOutputTokens: 1024,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text"],
  },
  // Tier 1 is the paid predicate; its price makes the first call's input
  // estimate alone cross the default session envelope ($1).
  {
    slug: PRICED,
    displayName: "Golden Priced",
    tier: 1,
    contextWindow: 32768,
    maxOutputTokens: 1024,
    costInput: 5000,
    costOutput: 5000,
    capabilities: ["text"],
  },
  // Cheap enough to pass the pre-call envelopes; the model server reports
  // usage large enough that actual spend trips the anomaly hard stop.
  {
    slug: METERED,
    displayName: "Golden Metered",
    tier: 1,
    contextWindow: 32768,
    maxOutputTokens: 1024,
    costInput: 0.5,
    costOutput: 0.5,
    capabilities: ["text"],
  },
  // A small context window so a short session crosses the proactive
  // compression trigger. It must still hold the fixed request prefix (the
  // system prompt and the tool definitions, ~2,500 tokens) with room for
  // the padded turns: the engine fits every request to the window before it
  // is sent and fails one that cannot fit, so a window under the prefix
  // would never reach the model.
  {
    slug: SMALL,
    displayName: "Golden Small Context",
    tier: 0,
    contextWindow: 12_000,
    maxOutputTokens: 256,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text"],
  },
];

const WORKSPACE_FILES = {
  "notes.txt": "Golden note line one.\nGolden note line two.\n",
};

// ── Model script ────────────────────────────────────────────────────────────

function contentText(message: ChatMessage | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content ?? "");
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/** The tool result the runtime sent back since the latest user message. */
function toolResultSinceLastUser(messages: ChatMessage[]): string | undefined {
  const tail = messages.slice(lastUserIndex(messages) + 1);
  const tool = tail.find((message) => message.role === "tool");
  return tool === undefined ? undefined : contentText(tool);
}

const COMPRESSION_SUMMARY = [
  "## Session intent",
  "Exercise transcript compression.",
  "## Decisions & outcomes",
  "(none)",
  "## Open threads",
  "(none)",
  "## Key facts & references",
  "(none)",
  "## Tool activity",
  "(none)",
  "## Operator's words",
  "(none)",
].join("\n");

// ~885 tokens per padded message: the fourth turn's history crosses the
// 50% trigger of the small window; the third turn's does not.
const PADDING = " Padding keeps this turn long enough to fill a small window."
  .repeat(60);

function goldenScript(request: ChatRequest): ModelReply {
  const messages = request.messages ?? [];
  const system = contentText(messages.find((m) => m.role === "system"));
  if (system.startsWith("You compress a conversation transcript")) {
    return { kind: "text", text: COMPRESSION_SUMMARY };
  }
  const prompt = contentText(messages[lastUserIndex(messages)]);
  const toolResult = toolResultSinceLastUser(messages);
  const marker = prompt.match(/\[golden:(s\d+)\]/)?.[1] ?? "default";
  switch (marker) {
    case "s2":
      return toolResult === undefined
        ? { kind: "tool", tool: "read_file", arguments: { path: "notes.txt" } }
        : { kind: "text", text: `Read result:\n${toolResult}` };
    case "s3":
      return toolResult === undefined
        ? {
          kind: "tool",
          tool: "write_file",
          arguments: { path: "golden-out.txt", content: "must not land" },
        }
        : { kind: "text", text: `Write result:\n${toolResult}` };
    case "s4":
      return toolResult === undefined
        ? {
          kind: "tool",
          tool: "bash",
          arguments: { command: "echo golden-bash-output" },
        }
        : { kind: "text", text: `Bash result:\n${toolResult}` };
    case "s5":
      return {
        kind: "text",
        text: `History seen: ${
          messages.map((m) => `${m.role}:${contentText(m).slice(0, 40)}`)
            .slice(1)
            .join(" | ")
        }`,
      };
    case "s7":
      return toolResult === undefined
        ? {
          kind: "tool",
          tool: "read_file",
          arguments: { path: "notes.txt" },
          usage: { promptTokens: 400_000, completionTokens: 1_000 },
        }
        : { kind: "text", text: "The anomaly gate should have halted this." };
    case "s9":
      return { kind: "hold", text: "Partial golden output" };
    case "s12":
      return { kind: "text", text: `Small-context reply.${PADDING}` };
    default:
      return { kind: "text", text: `Golden reply (${marker}).` };
  }
}

// ── Capture helpers ─────────────────────────────────────────────────────────

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Resolve just after the next wall-clock second begins. */
async function nextWallClockSecond(): Promise<void> {
  const wait = 1_000 - (Date.now() % 1_000) + 25;
  await new Promise((resolve) => setTimeout(resolve, wait));
}

function sessionIdOf(value: unknown): string {
  const record = value as { sessionId?: unknown };
  if (typeof record?.sessionId !== "string") {
    throw new Error(`no sessionId in ${JSON.stringify(value)}`);
  }
  return record.sessionId;
}

interface SharedState {
  firstSessionId?: string;
  firstEventId?: string;
}

interface Scenario {
  id: string;
  title: string;
  run(harness: Harness, state: SharedState): Promise<unknown>;
}

const approveAll = () => ({ decision: "approve" });

/** One raw JSON-RPC turn on a fresh connection, with everything it received. */
async function rpcTurn(
  harness: Harness,
  params: Record<string, unknown>,
  approver?: () => unknown,
): Promise<unknown> {
  const client = await harness.rpc(OPERATOR, approver);
  try {
    const response = await client.call("turn", params);
    return {
      response,
      received: client.received,
      approvals: client.approvals,
    };
  } finally {
    await client.close();
  }
}

const SCENARIOS: Scenario[] = [
  {
    id: "01-one-shot-text",
    title: "one-shot text turn, local model",
    async run(harness, state) {
      const rendered = await harness.cli(OPERATOR, [
        "exec",
        "[golden:s1] Say hello.",
      ]);
      const json = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "[golden:s1] Say hello as JSON.",
      ]);
      state.firstSessionId = sessionIdOf(JSON.parse(json.stdout));
      return {
        cliRendered: rendered,
        cliJson: { ...json, stdout: parseJsonOrText(json.stdout) },
      };
    },
  },
  {
    id: "02-read-file-then-answer",
    title: "multi-step turn: read_file then an answer (operator)",
    async run(harness) {
      const run = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "--model",
        LOCAL,
        "[golden:s2] What is in notes.txt?",
      ]);
      return { cli: { ...run, stdout: parseJsonOrText(run.stdout) } };
    },
  },
  {
    id: "03-strict-mutation-rejected",
    title: "mutating tool under strict, non-interactive client rejects",
    async run(harness) {
      const run = await harness.cli(STRICT, [
        "exec",
        "--json",
        "--model",
        LOCAL,
        "[golden:s3] Write golden-out.txt.",
      ]);
      return {
        cli: { ...run, stdout: parseJsonOrText(run.stdout) },
        fileWritten: await exists(`${harness.workspace}/golden-out.txt`),
      };
    },
  },
  {
    id: "04-bash-approved",
    title: "bash always asks; approved by the scripted approver",
    async run(harness) {
      return await rpcTurn(harness, {
        prompt: "[golden:s4] Run the golden command.",
        workspace: harness.workspace,
        routingOptions: { modelId: LOCAL },
      }, approveAll);
    },
  },
  {
    id: "05-continue-session",
    title: "continue an existing session (history projection)",
    async run(harness, state) {
      // Session activity is ordered at one-second granularity (see the bug
      // log: session timestamps lose sub-second precision), so a resume in
      // the same second as the previous scenario's session would tie and
      // sort by id. Start the resume on a fresh second so the ordering that
      // scenario 10 pins does not depend on timing.
      await nextWallClockSecond();
      const run = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "--session",
        state.firstSessionId!,
        "[golden:s5] What did we say before?",
      ]);
      return { cli: { ...run, stdout: parseJsonOrText(run.stdout) } };
    },
  },
  {
    id: "06-paid-envelope-fail-closed",
    title: "priced model crossing the session envelope, non-interactive",
    async run(harness) {
      const cli = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "--model",
        PRICED,
        "[golden:s6] This must not reach the model.",
      ]);
      // Raw client, paid opt-in given, per-call limit raised on the loopback
      // transport: only the session envelope is crossed, and the scripted
      // approver declines it.
      const sessionOnly = await rpcTurn(harness, {
        prompt: "[golden:s6] Session envelope only.",
        workspace: harness.workspace,
        routingOptions: { modelId: PRICED },
        approvePaidInference: true,
        budget: { perCallLimitUsd: 100 },
      });
      // Envelopes raised clear of the estimate, no paid opt-in: the paid
      // predicate (tier 1) reaches the consent gate, which fails closed.
      const noConsent = await rpcTurn(harness, {
        prompt: "[golden:s6] Paid consent not given.",
        workspace: harness.workspace,
        routingOptions: { modelId: PRICED },
        budget: { sessionLimitUsd: 100, perCallLimitUsd: 100 },
      });
      return {
        cli: { ...cli, stdout: parseJsonOrText(cli.stdout) },
        rpcSessionEnvelopeOnly: sessionOnly,
        rpcPaidConsentNotGiven: noConsent,
        modelRequestsForScenario:
          harness.modelServer.requests.filter((r) =>
            JSON.stringify(r.messages).includes("[golden:s6]")
          ).length,
      };
    },
  },
  {
    id: "07-anomaly-hard-stop",
    title: "anomaly hard stop at the configured multiple",
    async run(harness) {
      const run = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "--approve-paid",
        "--model",
        METERED,
        "[golden:s7] Read notes.txt twice.",
      ]);
      return { cli: { ...run, stdout: parseJsonOrText(run.stdout) } };
    },
  },
  {
    id: "08-acp-fixture-runner",
    title: "--runner fixture ACP turn against the fixture agent",
    async run(harness) {
      const run = await harness.cli(OPERATOR, [
        "exec",
        "--json",
        "--runner",
        "fixture",
        "[golden:s8] Hello, fixture agent.",
      ]);
      return { cli: { ...run, stdout: parseJsonOrText(run.stdout) } };
    },
  },
  {
    id: "09-turn-cancel",
    title: "turn/cancel mid-stream",
    async run(harness) {
      const client = await harness.rpc(OPERATOR);
      const turnId = "8f0c2b7e-5d1a-4c3b-9e2f-1a2b3c4d5e6f";
      let cancel: Promise<{ result?: unknown; error?: unknown }> | undefined;
      client.onMessage((message) => {
        const params = message.params as { t?: string } | undefined;
        if (
          cancel === undefined && message.method === "stream" &&
          params?.t === "delta"
        ) {
          cancel = client.call("turn/cancel", { turnId });
        }
      });
      try {
        const response = await client.call("turn", {
          prompt: "[golden:s9] Stream until cancelled.",
          turnId,
          workspace: harness.workspace,
          routingOptions: { modelId: LOCAL },
        });
        const cancelResponse = await cancel;
        const afterwards = await client.call("turn/cancel", { turnId });
        return {
          response,
          cancelResponse,
          cancelAfterSettled: afterwards,
          streamFrames: client.received.filter((m) =>
            (m as { method?: string }).method === "stream"
          ),
        };
      } finally {
        await client.close();
      }
    },
  },
  {
    id: "10-read-methods",
    title: "read methods",
    async run(harness, state) {
      const client = await harness.rpc(OPERATOR);
      try {
        const sessionId = state.firstSessionId!;
        const events = await client.call("events/query", { sessionId });
        const firstEvent = (events.result as {
          events?: Array<{ eventId?: string; event_id?: string }>;
        })?.events?.[0];
        state.firstEventId = firstEvent?.eventId ?? firstEvent?.event_id;
        return {
          "runtime/status": await client.call("runtime/status"),
          "runtime/liveness": await client.call("runtime/liveness"),
          "surface/snapshot": await client.call("surface/snapshot", {
            workspace: harness.workspace,
          }),
          "models/list": await client.call("models/list"),
          "sessions/list": await client.call("sessions/list"),
          "sessions/inspect": await client.call("sessions/inspect", {
            sessionId,
          }),
          "events/query": events,
          "tools/list": await client.call("tools/list", {
            workspace: harness.workspace,
          }),
          "tools/inspect": await client.call("tools/inspect", {
            commandId: "read_file",
            workspace: harness.workspace,
          }),
        };
      } finally {
        await client.close();
      }
    },
  },
  {
    id: "11-extension-methods",
    title: "extension methods with loopback third-party fakes",
    async run(harness, state) {
      const client = await harness.rpc(OPERATOR, approveAll);
      try {
        const sessionId = state.firstSessionId!;
        const mark = await client.call("ideas/mark", {
          sessionId,
          label: "Golden idea",
          description: "An idea marked by the golden suite.",
        });
        const ideaId = (mark.result as { idea?: { ideaId?: string } })?.idea
          ?.ideaId;
        const draft = await client.call("packets/draft", {
          sessionId,
          ideaId,
          title: "Golden packet",
          operatorIntent: "Characterize packet drafting.",
        });
        const packetId = (draft.result as { packet?: { packetId?: string } })
          ?.packet?.packetId;
        return {
          "ideas/mark": mark,
          "ideas/list": await client.call("ideas/list", { sessionId }),
          "ideas/get": await client.call("ideas/get", { ideaId }),
          "packets/draft": draft,
          "packets/list": await client.call("packets/list", { sessionId }),
          "packets/get": await client.call("packets/get", { packetId }),
          "friction/post": await client.call("friction/post", {
            severity: "minor",
            escaped: false,
            text: "Golden friction entry.",
            context: { sessionId, model: LOCAL, command: "/golden" },
          }),
          approvals: client.approvals,
          linearCalls: harness.linear.calls,
        };
      } finally {
        await client.close();
      }
    },
  },
  {
    id: "12-transcript-compression",
    title: "transcript compression triggered by a small context profile",
    async run(harness) {
      const run = await harness.repl(OPERATOR, ["--model", SMALL], [
        `[golden:s12] First turn.${PADDING}`,
        `[golden:s12] Second turn.${PADDING}`,
        `[golden:s12] Third turn.${PADDING}`,
        `[golden:s12] Fourth turn.${PADDING}`,
        "/session",
        "/exit",
      ]);
      return {
        cliRepl: run,
        compressionRequests: harness.modelServer.requests.filter((r) =>
          (r.messages ?? []).some((m) =>
            m.role === "system" &&
            String(m.content).startsWith(
              "You compress a conversation transcript",
            )
          )
        ),
      };
    },
  },
];

// ── Snapshot comparison ─────────────────────────────────────────────────────

function firstDifference(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n- ${a[i] ?? "<missing>"}\n+ ${
        b[i] ?? "<missing>"
      }`;
    }
  }
  return "(no line difference)";
}

async function matchSnapshot(id: string, value: unknown): Promise<void> {
  const path = `${SNAPSHOT_DIR}/${id}.json`;
  const actual = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    await Deno.mkdir(SNAPSHOT_DIR, { recursive: true });
    await Deno.writeTextFile(path, actual);
    return;
  }
  let expected: string;
  try {
    expected = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new AssertionError({
        message: `missing golden snapshot ${id}; run with -- --update`,
      });
    }
    throw error;
  }
  if (expected !== actual) {
    throw new AssertionError({
      message: `golden snapshot ${id} changed at ${
        firstDifference(expected, actual)
      }`,
    });
  }
}

// ── Suite ───────────────────────────────────────────────────────────────────

Deno.test("golden characterization suite", async (t) => {
  const harness = await startHarness({
    models: MODELS,
    script: goldenScript,
    workspaceFiles: WORKSPACE_FILES,
  });
  const state: SharedState = {};
  try {
    for (const scenario of SCENARIOS) {
      await t.step(`${scenario.id}: ${scenario.title}`, async () => {
        const capture = await scenario.run(harness, state);
        const rows = await harness.newRows();
        const normalized = harness.normalizer().normalize({
          scenario: scenario.title,
          capture,
          rows,
        });
        await matchSnapshot(scenario.id, normalized);
      });
    }
  } finally {
    await harness.close();
  }
});
