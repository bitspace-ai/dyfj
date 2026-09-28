/**
 * engine/ (L3): the turn pipeline (specs/01-architecture.md §5.1).
 *
 * Responsibility, so far: route resolution (`route.ts`: runner choice, native
 * model selection, the paid-escalation preflight), the observed provider call
 * (`observed-call.ts`: call, `provider_call` event, budget record), the
 * engine's error vocabulary and classifier (`errors.ts`), and best-effort
 * event writes (`event-writes.ts`). The rest of the turn still lives in
 * `src/workbench.ts` and `src/turn-runner.ts`, which the arch lane maps to
 * this unit until they move in.
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
