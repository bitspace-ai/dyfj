/**
 * Best-effort event writes for the engine: a write that must not fail the
 * turn is attempted, and a failure is counted and logged by error class
 * instead of thrown.
 */
import { classifyErrorKind } from "./errors.ts";

/**
 * Run an event write. With `bestEffort` false a failure propagates; with it
 * true the failure is counted through `onSkip` and logged by class only.
 */
export async function writeMaybe(
  operation: () => Promise<void>,
  bestEffort: boolean,
  onSkip?: () => void,
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    if (!bestEffort) throw err;
    // Best-effort is deliberately loud, never silent: every skipped write is
    // counted by the session (surfaced on the receipt and in the budget
    // summary) so an audit-log gap is visible instead of discoverable only
    // by diffing the event log against reality.
    onSkip?.();
    // Class only, never the message: a rejected event INSERT (e.g. Dolt's
    // "value too large for column" error) embeds the full offending value in
    // its message, so logging it verbatim here would leak onto the server
    // console exactly the payload this best-effort skip exists to keep durable
    // (or not) without surfacing (CWE-532; mirrors the turn-error discipline
    // at the runtime's [turn-error] console.error). The label comes from the
    // fixed-literal class table, never `.constructor.name` — that is an
    // ordinary writable property a foreign error can shadow with a payload.
    console.warn(`Event write skipped: ${classifyErrorKind(err)}`);
  }
}
