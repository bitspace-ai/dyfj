/**
 * tools/ (L2): the command primitive (`specs/01-architecture.md` section 5.4).
 *
 * Responsibility: the one tool shape (`definition.ts`), the registry
 * (`registry.ts`), argument validation (`validate.ts`), the call-shape policy
 * (`policy.ts`), the shared redactor for schema-declared redaction
 * (`redaction.ts`), invoke-with-event (`invoke.ts`) and the one catalog
 * builder (`catalog.ts`). Tools live in `builtin/` (memory, file, exec, git),
 * `web/` and `mcp/`, each exporting a `define<Name>` beside its executor.
 *
 * `mcp/` also holds the external-server adapter (`adapter.ts`), memory recall
 * over MCP (`memory-search.ts`) and MCP trace-context and list rules
 * (`conformance.ts`); `builtin/memory-records.ts` is the memory record format.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, and `store/` (the
 * `tool_call` event builder and the memory reader). Every tool the catalog can register passes the tool
 * conformance kit (`testing/conformance/tool.ts`); adding one follows
 * `specs/recipes/add-tool.md`.
 */

export type {
  CommandCall,
  CommandDefinition,
  CommandEffect,
  CommandExecutionContext,
  CommandInvocationResult,
  CommandPolicyResult,
  CommandTraceContext,
  ConfirmToolApproval,
  JsonSchemaObject,
  JsonSchemaProperty,
  PermissionEnvelope,
  PolicyDecision,
  PrincipalType,
  ToolApprovalRequest,
  ToolApprovalVerdict,
  ToolProjection,
} from "./definition.ts";
export { CommandExecutionError } from "./definition.ts";
export { type CommandRegistry, createCommandRegistry } from "./registry.ts";
export {
  formatInvalidArgumentsReason,
  validateCommandArguments,
} from "./validate.ts";
export { type CommandPolicyContext, evaluateCommandPolicy } from "./policy.ts";
export {
  redactCommandArguments,
  redactCommandResult,
  REDACTED,
  type RedactedToolCall,
  redactToolCall,
} from "./redaction.ts";
export {
  buildCommandToolCallEventPayload,
  type CommandEventContext,
  EVENT_RESULT_MAX_BYTES,
  invokeCommand,
  invokeCommandWithEvent,
  truncateForEventColumn,
} from "./invoke.ts";
export {
  buildToolCatalog,
  BUILTIN_TOOLS,
  type ToolCatalogConfig,
  type ToolCatalogDependencies,
  type ToolCatalogEntry,
  type ToolCatalogPorts,
} from "./catalog.ts";
export { executeReadMemory } from "./builtin/memory.ts";
export { RootAnchors } from "./builtin/root-anchors.ts";
export {
  buildMemoryContextSourceLines,
  buildSystemPrompt,
  loadIndexedMemories,
  loadInjectedMemories,
} from "./builtin/memory-records.ts";
export {
  buildExternalMcpCommands,
  externalMcpCommandsForTransport,
} from "./mcp/adapter.ts";
export {
  buildMemorySearch,
  memorySearchConfigFromEnv,
} from "./mcp/memory-search.ts";
