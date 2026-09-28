/**
 * engine/ (L3): the turn pipeline (specs/01-architecture.md §5.1).
 *
 * Responsibility: the turn entry (`turn.ts`: session lock, resume
 * reconstruction, boundary config; `turn-request.ts`: request validation),
 * session ownership (`session-owner.ts`: the single writer for each session's
 * turn lock and turn cancel signals), route resolution (`route.ts`: runner
 * choice, native model selection, the paid-escalation preflight), the observed
 * provider call (`observed-call.ts`: call, `provider_call` event, budget
 * record), the engine's error vocabulary and classifier (`errors.ts`), and
 * best-effort event writes (`event-writes.ts`). The native turn itself is
 * `native-runner.ts`, which the pipeline stages are being extracted from.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, and the L2 units
 * (`store/`, `providers/`, `tools/`, `budget/`, `context/`, `transport/`).
 * Runners (`runners/acp/`) never import the engine; the engine reaches them
 * through the `Runner` interface in `contract/`.
 */
export {
  classifyErrorKind,
  ContextCompressionPersistenceUncertainError,
  PaidEscalationDeclinedError,
  ToolStepLimitConclusionError,
  WorkspaceContextUnavailableError,
} from "./errors.ts";
export { writeMaybe } from "./event-writes.ts";
export {
  type ObservedCallContext,
  type ObservedCallRequest,
  type ObservedCallResult,
  observedProviderCall,
  type ProviderCallPurpose,
} from "./observed-call.ts";
export {
  buildPaidEscalationPreflightBanner,
  type ConfirmPaidEscalation,
  confirmPaidRoute,
  formatMoney,
  isNextWorkMode,
  maybeBuildPaidEscalationPreflightBanner,
  type ModelRoute,
  type PaidEscalationPreflightInput,
  type ResolvedRoute,
  resolveRoute,
  type RouteModelReader,
  routeReasonForMode,
  type RouteRequest,
  selectModelRoute,
} from "./route.ts";
export {
  AGENTS_INSTRUCTIONS_TRUST_PREAMBLE,
  buildWorkspaceGrounding,
  MAX_TOOL_STEPS,
  runWorkbenchRuntime,
  toolStepToMessages,
} from "./native-runner.ts";
export {
  buildNextWorkBrief,
  type NextWorkBriefInput,
  type NextWorkResult,
  type NextWorkValidationResult,
  validateNextWorkJson,
} from "./next-work.ts";
export {
  type BudgetTallyInput,
  buildBudgetTallyLine,
  buildWorkbenchReceipt,
  formatContextBudgetLine,
  formatTimingLine,
  shouldPrintBudgetTally,
  type WorkbenchReceiptInput,
} from "./receipt.ts";
export type {
  ExternalAgentRunner,
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
  WorkbenchRuntimeServices,
} from "./runtime-types.ts";
export type { NativeTurnPorts } from "./turn-state.ts";
export { SessionOwners, TurnTicket } from "./session-owner.ts";
export {
  engineConfigToTurnDeps,
  executeTurn,
  type ExecuteTurnDeps,
  type FetchSessionEvents,
  formatTurnSummaryLine,
  type TurnRuntime,
} from "./turn.ts";
export {
  isValidTurnId,
  PAID_ESCALATION_NOT_APPROVED,
  PAID_ESCALATION_REMOTE_DENIED,
  paidEscalationVerdict,
  parseBudgetOverride,
  type ResolvedTurn,
  resolveTurnFromBody,
  type ResolveTurnOptions,
  type TurnRequestBody,
} from "./turn-request.ts";
