/**
 * budget/ (L2): per-session spend tracking and the gates that bound it.
 *
 * Responsibility: the tracker (`tracker.ts`: per-turn accumulation, pre-call
 * envelope check, anomaly check, the `budget_summary` event), spend baselines
 * and the local-day boundary (`spend.ts`, through the store's spend reader and
 * the `Clock` port), the envelope gates (`envelope-gate.ts`: per-call, session
 * and daily ceilings, warn-then-confirm), the ceiling confirmation store
 * (`confirmations.ts`), and the runaway anomaly gate (`anomaly-gate.ts`: the
 * hard stop). Events are written through the store's journal.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, and `store/`
 * (specs/01-architecture.md §3).
 */
export {
  type AnomalyCheck,
  type AnomalyConfig,
  type AnomalyTrigger,
  type BudgetConfig,
  type BudgetLimitReason,
  type BudgetSummary,
  BudgetTracker,
  defaultBudgetConfig,
  type PreCallCheck,
  type SpendBaselines,
  type TierSpend,
} from "./tracker.ts";
export { fetchSpendBaselines, localDayKey, localDayStart } from "./spend.ts";
export {
  type BudgetCeilingConfirmations,
  ceilingConfirmationStoreFor,
  resetCeilingConfirmations,
} from "./confirmations.ts";
export {
  budgetCeilingApprovalRequest,
  BudgetCeilingDeclinedError,
  type BudgetCeilingVerdict,
  type BudgetCeilingWarning,
  BudgetExceededError,
  buildBudgetCeilingWarning,
  type ConfirmBudgetCeiling,
  createTurnBudgetCeilingGate,
  ensureBudgetAllowed,
  formatBudgetCeilingWarning,
  type TurnBudgetCeilingGate,
} from "./envelope-gate.ts";
export {
  buildRunawayAnomalyWarning,
  type ConfirmRunawayAnomaly,
  createRunawayAnomalyGate,
  ensureAnomalyAllowed,
  formatRunawayAnomalyWarning,
  runawayAnomalyApprovalRequest,
  type RunawayAnomalyGate,
  RunawayAnomalyHaltError,
  type RunawayAnomalyWarning,
} from "./anomaly-gate.ts";
