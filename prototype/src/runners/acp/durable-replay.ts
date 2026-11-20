import { createHash } from "node:crypto";
import { type ClientContext, methods, type StopReason } from "@agentclientprotocol/sdk";
import { AcpRunnerError } from "../../acp-errors.ts";

export const ACP_REPLAY_TIMEOUT_MS = 10_000;
export const ACP_REPLAY_UPDATE_LIMIT = 8_192;
export const ACP_REPLAY_BYTE_LIMIT = 8_388_608;

export type LiveSdkSession = {
  sessionId: string;
  prompt: (text: string) => Promise<unknown>;
  nextUpdate: () => Promise<
    | { kind: "session_update"; notification: { sessionId: string }; update: unknown }
    | { kind: "stop"; stopReason: StopReason; response?: { usage?: unknown } }
  >;
  dispose: () => void;
};

function digestAgentText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Consumed at protocol ingress, before SDK update routing or prompt observers. */
export class AcpReplay {
  #active = true;
  #text = "";
  #updates = 0;
  #bytes = 0;
  #elapsedMs = 0;
  readonly #started = Date.now();

  get stats() {
    return { updates: this.#updates, bytes: this.#bytes, elapsedMs: this.#elapsedMs };
  }

  consume(update: Record<string, unknown>, bytes: number): boolean {
    if (!this.#active) return false;
    this.#updates++;
    this.#bytes += bytes;
    if (this.#updates > ACP_REPLAY_UPDATE_LIMIT || this.#bytes > ACP_REPLAY_BYTE_LIMIT) {
      throw new AcpRunnerError("ACP replay exceeded its bounds", "session");
    }
    if (update.sessionUpdate === "user_message_chunk") this.#text = "";
    const content = update.content as { type?: unknown; text?: unknown } | undefined;
    if (update.sessionUpdate === "agent_message_chunk" &&
        content?.type === "text" && typeof content.text === "string") {
      this.#text += content.text;
    }
    return true;
  }

  verify(content: string): void {
    this.#elapsedMs = Date.now() - this.#started;
    this.#active = false;
    const matches = digestAgentText(this.#text) === digestAgentText(content);
    this.#text = "";
    if (!matches) throw new AcpRunnerError("ACP replay did not match recorded response", "session");
  }
}

export async function loadVerifiedAcpSession(
  context: ClientContext,
  roots: { workspace: string; additionalDirectories?: readonly string[] },
  candidate: { externalSessionId: string; content: string },
  replay: AcpReplay,
): Promise<{ session: LiveSdkSession; onUpdate: (params: { sessionId: string; update: unknown }) => void }> {
  await context.request(methods.agent.session.load, {
    sessionId: candidate.externalSessionId,
    cwd: roots.workspace,
    mcpServers: [],
    ...(roots.additionalDirectories?.length ? { additionalDirectories: [...roots.additionalDirectories] } : {}),
  });
  replay.verify(candidate.content);
  // The SDK exposes only a session/new builder. Attach this prompt queue
  // after replay; ingress bounds the queued updates for every exchange.
  type Update = Awaited<ReturnType<LiveSdkSession["nextUpdate"]>>;
  const queue: Update[] = [];
  let waiting: ((update: Update) => void) | undefined;
  let disposed = false;
  const push = (update: Update) => {
    if (disposed) return;
    if (waiting === undefined) queue.push(update);
    else { const resolve = waiting; waiting = undefined; resolve(update); }
  };
  const session: LiveSdkSession = {
    sessionId: candidate.externalSessionId,
    prompt: async (text) => {
      const response = await context.request(methods.agent.session.prompt, {
        sessionId: candidate.externalSessionId, prompt: [{ type: "text", text }],
      });
      push({ kind: "stop", stopReason: response.stopReason, response: response as { usage?: unknown } });
      return response;
    },
    nextUpdate: () => queue.length ? Promise.resolve(queue.shift()!) :
      new Promise((resolve) => { waiting = resolve; }),
    dispose: () => { disposed = true; queue.length = 0; waiting = undefined; },
  };
  return { session, onUpdate: (params) => push({ kind: "session_update", notification: params, update: params.update }) };
}
