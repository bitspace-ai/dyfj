/**
 * Turn-kind idle-limit selection for external-agent sessions (BIT-924).
 */
import { DEFAULT_ACP_IDLE_TTL_MS } from "../../acp-session-map.ts";
import {
  DEFAULT_CODEX_INTERACTIVE_IDLE_SECONDS,
  MAX_CODEX_INTERACTIVE_IDLE_SECONDS,
  MIN_CODEX_INTERACTIVE_IDLE_SECONDS,
} from "../../config/mod.ts";
import type { AcpRunnerSelection, DispatchRecord } from "../../contract/mod.ts";

export interface ExternalAgentIdleLimitInput {
  runner: AcpRunnerSelection;
  releaseExternalAgentSession?: boolean;
  dispatchRecord?: DispatchRecord;
  codexInteractiveIdleSeconds?: number;
}

/**
 * Select the idle limit for this turn's external-agent session from the turn's
 * own request and dispatch record: interactive `codex-chatgpt` turns keep the
 * configured interactive limit; one-shot turns, dispatched turns, and other
 * runners keep `DEFAULT_ACP_IDLE_TTL_MS`.
 */
export function selectExternalAgentIdleTtlMs(
  input: ExternalAgentIdleLimitInput,
  isDispatchedChild: boolean,
): number {
  const isOneShot = input.releaseExternalAgentSession === true;
  const isDispatched = input.dispatchRecord !== undefined || isDispatchedChild;
  if (isOneShot || isDispatched || input.runner.profile !== "codex-chatgpt") {
    return DEFAULT_ACP_IDLE_TTL_MS;
  }
  const configured = input.codexInteractiveIdleSeconds;
  const seconds = configured !== undefined &&
      Number.isInteger(configured) &&
      configured >= MIN_CODEX_INTERACTIVE_IDLE_SECONDS &&
      configured <= MAX_CODEX_INTERACTIVE_IDLE_SECONDS
    ? configured
    : DEFAULT_CODEX_INTERACTIVE_IDLE_SECONDS;
  return seconds * 1_000;
}
