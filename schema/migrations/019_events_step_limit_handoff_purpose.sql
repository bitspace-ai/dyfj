-- DYFJ — Name the step-limit handoff call in events.provider_call_purpose.
--
-- When a turn reaches its tool-step limit, the runtime makes a call with no
-- tools offered, asking the model for a handoff (what is done, what is next,
-- any uncommitted state); a length or context-size recovery may retry it as a
-- 'recovery' call. That call was recorded as 'forced_conclusion', which
-- also covers the conclusions after repeated tool calls and after a declined
-- tool approval, so the purpose alone could not find a handoff.
--
-- The new value goes last, so existing rows keep their stored values. The
-- statement sets the whole column definition, so running it again leaves the
-- column unchanged.

ALTER TABLE events
  MODIFY COLUMN provider_call_purpose ENUM(
    'initial',
    'tool_followup',
    'forced_conclusion',
    'recovery',
    'context_compression',
    'step_limit_handoff'
  ) NULL;
