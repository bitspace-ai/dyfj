/**
 * providers/ (L2): model providers behind one `ProviderAdapter` interface
 * (`specs/01-architecture.md` section 5.2).
 *
 * Responsibility: the model catalog (parsed from the store's model reader),
 * routing and the built-in local defaults (`registry/`), the header-deadline
 * request over the `HttpTransport` port (`http.ts`), code the adapters share
 * (`shared/`: SSE reading, text tool-call extraction, token estimates, wire
 * tool names, base-URL rules), and one directory per API family:
 * `openai-compatible/`, `anthropic/`, `gemini/`. `runWorkbenchTurn` selects a
 * model and dispatches to the adapter that serves its provider.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`. The catalog is
 * read through a structurally typed reader, so this directory does not import
 * `store/`. Every adapter passes the provider conformance kit
 * (`testing/conformance/provider-adapter.ts`); adding one follows
 * `specs/recipes/add-provider.md`.
 */

export type {
  FetchLike,
  ModelAccessModality,
  WorkbenchCallTimings,
  WorkbenchMessage,
  WorkbenchModel,
  WorkbenchRoutingOptions,
  WorkbenchSelection,
  WorkbenchToolCall,
  WorkbenchToolDefinition,
  WorkbenchTurnParams,
  WorkbenchTurnResult,
} from "./types.ts";
export {
  HostedInferenceRequiresProviderError,
  HostedProviderCredentialMissingError,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchLocalProviderBaseUrlError,
  WorkbenchModelFastSpeedUnsupportedError,
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "./errors.ts";
export type {
  BaseUrlCheck,
  MonotonicClock,
  ProviderAdapter,
  ProviderFrame,
  ProviderIO,
  ProviderTurnRequest,
} from "./adapter.ts";
export {
  fetchWithHeaderTimeout,
  type HttpTransport,
  PROVIDER_BUFFERED_HEADER_TIMEOUT_MS,
  PROVIDER_HEADER_TIMEOUT_MS,
} from "./http.ts";
export {
  getModelAccessModality,
  loadWorkbenchModels,
  modelHasCatalogPricing,
  parseModelRegistryRows,
} from "./registry/catalog.ts";
export {
  defaultLocalWorkbenchModels,
  loadWorkbenchModelsWithLocalDefaults,
  withDefaultLocalWorkbenchModels,
} from "./registry/local-defaults.ts";
export {
  isLocalWorkbenchModel,
  modelSupportsFastSpeed,
  selectWorkbenchModel,
} from "./registry/routing.ts";
export {
  createProviderRegistry,
  modelRequestedOutputCap,
  modelStreamsToolCalls,
  modelSupportsTranscriptRetry,
  PROVIDER_ADAPTERS,
  type ProviderRegistry,
  runWorkbenchTurn,
} from "./registry/registry.ts";
export { estimateTextTokens } from "./shared/tokens.ts";
