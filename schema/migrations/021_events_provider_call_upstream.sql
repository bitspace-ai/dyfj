-- DYFJ — Record which upstream served a provider call, and the provider's
-- generation id for it.
--
-- The `provider` column names the configured provider, which for an aggregator
-- is the aggregator itself ("openrouter") rather than the upstream that
-- answered. Prompt-cache behaviour is per upstream: the same request routed to
-- a different upstream reads an empty cache. Recording the upstream that
-- served each call makes that answerable from the event log.
--
-- Both values are provider-supplied text. They are bounded and stripped of
-- control characters before they reach the row. NULL means no usable value was
-- kept for that call: the provider reported none, or what it reported did not
-- survive sanitizing. A call that throws before returning a result keeps
-- neither field.

ALTER TABLE events
  ADD COLUMN upstream_provider VARCHAR(64) NULL AFTER provider_error_class,
  ADD COLUMN provider_generation_id VARCHAR(128) NULL AFTER upstream_provider;
