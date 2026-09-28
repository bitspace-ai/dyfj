/**
 * A turn executor the engine delegates to. The engine names the input and
 * result it hands a runner, the composition root binds a concrete runner to
 * it, and runner modules never import the engine (specs/01-architecture.md
 * §3, same-layer edges). Inputs and results are the contract types in this
 * directory plus whatever in-process hooks the engine passes through.
 */
export interface Runner<Input, Result> {
  run(input: Input): Promise<Result>;
}

/**
 * An external agent's permission request as the engine relays it to the
 * operator: the tool call it wants to run and the protocol options it offers.
 */
export interface AcpPermissionPrompt {
  sessionId: string;
  toolCallId: string;
  toolCall: {
    title: string;
    name?: string;
    kind?: string;
    inputSummary: string;
  };
  options: ReadonlyArray<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

/** The protocol option the operator chose, or none. */
export interface AcpPermissionSelection {
  optionId: string | null;
  source?: "operator" | "policy";
}
