/**
 * context/ (L2): what the model sees on a turn, assembled from the workspace
 * and the session's history.
 *
 * Responsibility: workspace/repo context packing and AGENTS.md loading
 * (`repo-context.ts`), companion prompt composition (`prompts.ts`), transcript
 * compression (`compression.ts`), length-stop and context-overflow recovery
 * (`length-recovery.ts`), request fitting against the model's context
 * window (`request-fit.ts`), and the conversation projection that rebuilds
 * a session's prior turns from its events (`conversation.ts`).
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, `store/`, and
 * `providers/` for types only (specs/01-architecture.md §3).
 */
export * from "./compression.ts";
export * from "./conversation.ts";
export * from "./length-recovery.ts";
export * from "./prompts.ts";
export * from "./repo-context.ts";
export * from "./request-fit.ts";
