-- DYFJ Workbench — Add budget_summary to events ENUM
--
-- A budget summary is a distinct event type written once per session at
-- session-end by BudgetTracker.writeSummaryEvent(). It captures the full
-- cost and token ledger so scorecard views can read a single row per session
-- rather than scanning and aggregating every model_response event.
--
-- Field usage for budget_summary events:
--   event_type    = 'budget_summary'
--   tokens_input  = total session input tokens (all tiers)
--   tokens_output = total session output tokens (all tiers)
--   cost_total    = total session cost USD (all tiers)
--   content       = JSON: {
--                     totalCostUsd, totalTokensInput, totalTokensOutput,
--                     totalCalls, config: { sessionLimitUsd, perCallLimitUsd },
--                     byTier: {
--                       "0": { calls, tokensInput, tokensOutput, costUsd },
--                       "1": { ... },
--                       "2": { ... }
--                     }
--                   }
--   resource      = 'session_budget'
--   action        = 'summarise'

ALTER TABLE events
  MODIFY COLUMN event_type
    ENUM('model_response','tool_call','error','session_start','session_end',
         'model_selected','budget_summary')
    NOT NULL;
