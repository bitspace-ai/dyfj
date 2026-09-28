/**
 * A native turn once `budgetGate` has routed it: everything the later
 * stages (`loadTranscript`, `agentLoop`) share. The pipeline builds it once
 * and hands the same bundle to each stage.
 */
import type { TurnRoute } from "./budget-gate.ts";
import type { ObservedCallContext } from "./observed-call.ts";
import type { WorkbenchRuntimeInput } from "./runtime-types.ts";
import type { NativeTurnPorts, TurnState } from "./turn-state.ts";

export interface RoutedTurn {
  state: TurnState;
  input: WorkbenchRuntimeInput;
  ports: NativeTurnPorts;
  route: TurnRoute;
  /** The context every provider call of the turn records under. */
  observed: ObservedCallContext;
}
