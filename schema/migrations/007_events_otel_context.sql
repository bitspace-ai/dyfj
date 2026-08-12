-- Add minimized OpenTelemetry evidence without duplicating canonical IDs.
-- Raw traceparent and baggage are propagation envelopes, not durable columns.

ALTER TABLE events
  ADD COLUMN trace_flags TINYINT UNSIGNED NULL AFTER parent_span_id,
  ADD COLUMN trace_state VARCHAR(512) NULL AFTER trace_flags,
  ADD COLUMN span_kind ENUM('internal', 'server', 'client', 'producer', 'consumer') NULL AFTER trace_state,
  ADD COLUMN parent_is_remote BOOLEAN NULL AFTER span_kind;
