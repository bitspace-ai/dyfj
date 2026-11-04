// The ACP runner's errors, and the mapping of a JSON-RPC error an agent
// answered with to one of them. That mapping leaves the agent's own error
// text out of the message it builds.

import { RequestError } from "@agentclientprotocol/sdk";
import { sanitizeBoundaryText } from "./kernel/mod.ts";
import { DomainError } from "./contract/mod.ts";

/** What an error message may say about the agent: its profile's identity. */
export interface AcpAgentIdentity {
  slug: string;
  requiredAuthentication?: "chat-gpt";
}

/**
 * A failure of the ACP runner. It crosses the turn boundary as a
 * `DomainError`, with its message as written, instead of `[Error, N bytes]`.
 * The class does not check where a message came from: each caller builds it,
 * from fixed text and bounded runner values (a phase, a JSON-RPC code, the
 * profile slug) or, for a failed spawn, sanitized subprocess diagnostics.
 */
export class AcpRunnerError extends DomainError {
  public readonly phase:
    | "spawn"
    | "initialize"
    | "authenticate"
    | "session"
    | "prompt"
    | "cancel"
    | "permission"
    | "protocol"
    | "terminate";
  constructor(message: string, phase: AcpRunnerError["phase"]) {
    super(message);
    this.phase = phase;
    this.name = "AcpRunnerError";
  }
}

export class AcpSessionUpdateLimitError extends AcpRunnerError {
  constructor() {
    super("ACP agent exceeded the session-update limit", "protocol");
  }
}

export class AcpProtocolMessageLimitError extends AcpRunnerError {
  constructor() {
    super("ACP agent exceeded the protocol-message limit", "protocol");
  }
}

/**
 * The external agent is not signed in: `authentication/status` said so, or
 * the agent answered a request with ACP's `auth_required` error (JSON-RPC
 * -32000), as the Codex adapter does once its ChatGPT sign-in has expired.
 * The message says how to sign in again.
 */
export class AcpAuthenticationRequiredError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor(
    profile: AcpAgentIdentity = {
      slug: "codex-chatgpt",
      requiredAuthentication: "chat-gpt",
    },
  ) {
    super(
      profile.requiredAuthentication === "chat-gpt"
        ? "The Codex runner's ChatGPT sign-in is missing or has expired. " +
          "Sign its home in again with `cd prototype && npm run " +
          "codex-chatgpt-login`, then retry the turn"
        : `The external agent ${
          sanitizeBoundaryText(profile.slug, MAX_PROFILE_SLUG_BYTES)
        } requires authentication (ACP auth_required); sign it in, then ` +
          "retry the turn",
    );
    this.name = "AcpAuthenticationRequiredError";
  }
}

/** ACP's `auth_required` error code. */
const ACP_AUTH_REQUIRED = -32000;
const MAX_PROFILE_SLUG_BYTES = 64;

/**
 * The runner error for a JSON-RPC error the agent answered a request with, or
 * undefined when `error` is not one. Only the SDK's `RequestError`, which it
 * rejects a request with when the response carries an error, counts: a local
 * error that happens to carry a numeric `code` (an `AbortError`'s 20, say) is
 * not the agent's answer. `auth_required` becomes
 * `AcpAuthenticationRequiredError`; any other code is named, and the agent's
 * message, which can carry anything its service said, is left out.
 */
export function agentRequestFailure(
  error: unknown,
  phase: "session" | "prompt",
  profile: AcpAgentIdentity,
): DomainError | undefined {
  if (error instanceof DomainError) return error;
  if (!(error instanceof RequestError)) return undefined;
  const code: unknown = error.code;
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return undefined;
  if (code === ACP_AUTH_REQUIRED) {
    return new AcpAuthenticationRequiredError(profile);
  }
  const agent = sanitizeBoundaryText(profile.slug, MAX_PROFILE_SLUG_BYTES);
  return new AcpRunnerError(
    phase === "prompt"
      ? `The external agent ${agent} reported that the turn failed ` +
        `(JSON-RPC ${code}); its own message is not shown. Retry the turn, ` +
        "or check the agent outside Workbench"
      : `The external agent ${agent} refused to start a session ` +
        `(JSON-RPC ${code}); its own message is not shown. Check the agent ` +
        "outside Workbench, then retry",
    phase,
  );
}

export class AcpAccessRouteMismatchError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor() {
    super("Codex ACP is not using ChatGPT authentication");
    this.name = "AcpAccessRouteMismatchError";
  }
}

export class AcpAuthenticationEvidenceError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor() {
    super("Codex ACP authentication evidence is unavailable");
    this.name = "AcpAuthenticationEvidenceError";
  }
}
/**
 * The error a failed prompt request ends the turn with: the agent's own
 * JSON-RPC error when it sent one, else the generic prompt failure.
 */
export function promptFailure(
  error: unknown,
  profile: AcpAgentIdentity,
): DomainError {
  return agentRequestFailure(error, "prompt", profile) ??
    new AcpRunnerError(
      "ACP prompt request failed before the turn completed",
      "prompt",
    );
}

/**
 * The error a failed session start ends with: the agent's own JSON-RPC error
 * when it sent one, else `error` unchanged.
 */
export function sessionFailure(
  error: unknown,
  profile: AcpAgentIdentity,
): unknown {
  return agentRequestFailure(error, "session", profile) ?? error;
}
