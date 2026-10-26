/**
 * budget/ (L2): per-session spend tracking and the gates that bound it.
 *
 * Responsibility: the tracker (`tracker.ts`: per-turn accumulation, pre-call
 * spend check figures, tool-progress mark, the `budget_summary` event), spend
 * baselines and the local-day boundary (`spend.ts`, through the store's spend
 * reader and the `Clock` port), the spend check (`envelope-gate.ts`: the
 * per-call, runaway, turn, session and daily limits, warn-then-confirm), and
 * the confirmation store (`confirmations.ts`). Events are written through the
 * store's journal.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, and `store/`
 * (specs/01-architecture.md §3).
 */
export {
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
  CeilingConfirmationStore,
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
  formatUsd,
  spendLimitLabel,
  type TurnBudgetCeilingGate,
} from "./envelope-gate.ts";
