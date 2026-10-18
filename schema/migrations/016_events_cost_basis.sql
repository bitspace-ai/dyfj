-- DYFJ — Record where each event's cost_total came from.
--
-- 'provider_billed' is the amount the provider reported charging for the
-- call (OpenRouter's usage.cost). 'catalog_estimate' is the model row's rates
-- times the metered tokens. NULL on rows written before this column, and on
-- rows with no cost; readers treat a NULL basis beside a cost as
-- 'catalog_estimate', which is what every earlier cost was.

ALTER TABLE events
  ADD COLUMN cost_basis ENUM('provider_billed', 'catalog_estimate') NULL
    AFTER cost_total;
