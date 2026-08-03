-- DYFJ — Record bounded, content-free unparsed tool-call markup metadata.
--
-- The count extends the provider_call observability span. It never carries
-- model text, tool names, arguments, or surrounding markup. It counts unmatched
-- exact opening markers; a lower-bound bit distinguishes a capped count from an
-- exact count.

ALTER TABLE events
  ADD COLUMN unparsed_tool_call_count INT UNSIGNED NULL
    AFTER provider_error_class,
  ADD COLUMN unparsed_tool_call_count_is_lower_bound BOOLEAN NULL
    AFTER unparsed_tool_call_count;
