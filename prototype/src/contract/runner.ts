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
