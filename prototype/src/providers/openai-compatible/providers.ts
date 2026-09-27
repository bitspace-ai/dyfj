/**
 * The providers the OpenAI-compatible adapter serves: local servers reached
 * over loopback without a key, and hosted providers pinned to one https host
 * and one bearer-key variable each.
 */

export const openAICompatibleLocalProviders = new Set(["ollama", "mlx-lm"]);
/**
 * Hosted OpenAI-compatible providers: the env var each reads its bearer key
 * from, and the exact https host that key may be sent to. A static code-level
 * map rather than a catalog column: the set of env vars the runtime will ever
 * project as a bearer token — and where each one may go — stays enumerable in
 * reviewed code, so a catalog row cannot pair a credential with an arbitrary
 * base URL: a mis-catalogued provider/base_url combination fails closed
 * before any request, instead of sending one provider's key to another's
 * (still-https) endpoint. Membership here is also what admits a provider to
 * the hosted OpenAI-compatible wire path at all.
 */
export const openAIHostedProviderContracts: ReadonlyMap<
  string,
  { keyEnvVar: string; host: string }
> = new Map([
  ["openai", { keyEnvVar: "OPENAI_API_KEY", host: "api.openai.com" }],
  ["openrouter", { keyEnvVar: "OPENROUTER_API_KEY", host: "openrouter.ai" }],
  ["xai", { keyEnvVar: "XAI_API_KEY", host: "api.x.ai" }],
]);
export const openAIHostedProviders = new Set(
  openAIHostedProviderContracts.keys(),
);
export const HOSTED_OPENAI_DEFAULT_MAX_TOKENS = 8192;
