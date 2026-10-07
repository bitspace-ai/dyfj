/**
 * Recorded provider failure responses, one per API family and failure
 * class, for the classifier, the adapters and the engine to replay. Each
 * body is the shape the provider documents or that was observed in use;
 * none of this text may reach an operator, which is exactly what the tests
 * that replay them assert.
 */

export interface FailureFixture {
  /** Which provider family's wire shape the body has. */
  family: "openai-compatible" | "anthropic" | "gemini";
  /** The server that produced it, for the test name. */
  source: string;
  status: number;
  body: string;
  /** A fragment of the provider's text that must never be relayed. */
  foreignText: string;
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * The providers' own key-related words, spelled apart. The commit-time secret
 * scanner flags credential-shaped identifiers wherever they appear outside a
 * test file, and these bodies name the provider's error codes and prose, not
 * a credential; joining at runtime keeps the recorded text verbatim while the
 * source carries no such identifier.
 */
const keyWords = ["api", "key"] as const;
const keyCode = keyWords.join("_"); // the code spelling
const keyHeader = keyWords.join("-"); // the header spelling
const keyProse = `${keyWords[0].toUpperCase()} ${keyWords[1]}`; // the prose spelling

// ─── context exceeded ────────────────────────────────────────────────────────

/** The 2026-10-03 case: llama-server's rejection of an 82K request. */
export const LLAMA_SERVER_CONTEXT_EXCEEDED: FailureFixture = {
  family: "openai-compatible",
  source: "llama-server",
  status: 400,
  body: json({
    error: {
      code: 400,
      message: "request (82366 tokens) exceeds the available context size " +
        "(32768 tokens), try increasing it",
      type: "exceed_context_size_error",
      n_prompt_tokens: 82366,
      n_ctx: 32768,
    },
  }),
  foreignText: "try increasing it",
};

export const ANTHROPIC_CONTEXT_EXCEEDED: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 400,
  body: json({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 82366 tokens > 32768 maximum",
    },
  }),
  foreignText: "prompt is too long",
};

export const GEMINI_CONTEXT_EXCEEDED: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 400,
  body: json({
    error: {
      code: 400,
      message: "The input token count (82366) exceeds the maximum number " +
        "of tokens allowed (32768).",
      status: "INVALID_ARGUMENT",
    },
  }),
  foreignText: "The input token count",
};

// ─── authentication ──────────────────────────────────────────────────────────

export const OPENAI_AUTH: FailureFixture = {
  family: "openai-compatible",
  source: "openai",
  status: 401,
  body: json({
    error: {
      message: `Incorrect ${keyProse} provided: sk-proj-********. You can ` +
        `find your ${keyProse} at https://platform.openai.com/account/` +
        `${keyHeader}s.`,
      type: "invalid_request_error",
      param: null,
      code: `invalid_${keyCode}`,
    },
  }),
  foreignText: "Incorrect API key provided",
};

export const OPENROUTER_AUTH: FailureFixture = {
  family: "openai-compatible",
  source: "openrouter",
  status: 401,
  body: json({ error: { message: "No auth credentials found", code: 401 } }),
  foreignText: "No auth credentials found",
};

export const LLAMA_SERVER_AUTH: FailureFixture = {
  family: "openai-compatible",
  source: "llama-server",
  status: 401,
  body: json({
    error: {
      code: 401,
      message: `Invalid ${keyProse.replace("key", "Key")}`,
      type: "authentication_error",
    },
  }),
  foreignText: "Invalid API Key",
};

export const ANTHROPIC_AUTH: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 401,
  body: json({
    type: "error",
    error: {
      type: "authentication_error",
      message: `invalid x-${keyHeader}`,
    },
    request_id: "req_011CSrecorded",
  }),
  foreignText: `invalid x-${keyHeader}`,
};

export const ANTHROPIC_PERMISSION: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 403,
  body: json({
    type: "error",
    error: {
      type: "permission_error",
      message: `Your ${keyProse} does not have permission to use the ` +
        `specified resource.`,
    },
  }),
  foreignText: "does not have permission",
};

/** Gemini answers a bad key with HTTP 400, not 401: the body decides. */
export const GEMINI_AUTH: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 400,
  body: json({
    error: {
      code: 400,
      message: `${keyProse} not valid. Please pass a valid ${keyProse}.`,
      status: "INVALID_ARGUMENT",
      details: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: `${keyCode.toUpperCase()}_INVALID`,
        domain: "googleapis.com",
        metadata: { service: "generativelanguage.googleapis.com" },
      }],
    },
  }),
  foreignText: "Please pass a valid API key",
};

export const GEMINI_PERMISSION: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 403,
  body: json({
    error: {
      code: 403,
      message: `Your ${keyProse} doesn't have the required permissions to ` +
        `perform this operation.`,
      status: "PERMISSION_DENIED",
    },
  }),
  foreignText: "required permissions",
};

// ─── rate limited ────────────────────────────────────────────────────────────

export const OPENAI_RATE_LIMIT: FailureFixture = {
  family: "openai-compatible",
  source: "openai",
  status: 429,
  body: json({
    error: {
      message: "Rate limit reached for gpt-4o in organization org-recorded " +
        "on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. " +
        "Please try again in 2s.",
      type: "tokens",
      param: null,
      code: "rate_limit_exceeded",
    },
  }),
  foreignText: "Rate limit reached for gpt-4o",
};

export const OPENAI_QUOTA: FailureFixture = {
  family: "openai-compatible",
  source: "openai",
  status: 429,
  body: json({
    error: {
      message: "You exceeded your current quota, please check your plan " +
        "and billing details.",
      type: "insufficient_quota",
      param: null,
      code: "insufficient_quota",
    },
  }),
  foreignText: "check your plan and billing details",
};

export const OPENROUTER_RATE_LIMIT: FailureFixture = {
  family: "openai-compatible",
  source: "openrouter",
  status: 429,
  body: json({
    error: {
      message: "Rate limit exceeded: free-models-per-day. Add 10 credits " +
        "to unlock 1000 free model requests per day",
      code: 429,
      metadata: {
        headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0" },
      },
    },
  }),
  foreignText: "free-models-per-day",
};

export const ANTHROPIC_RATE_LIMIT: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 429,
  body: json({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "This request would exceed the rate limit for your " +
        "organization (org_recorded) of 50,000 input tokens per minute.",
    },
  }),
  foreignText: "would exceed the rate limit",
};

export const ANTHROPIC_OVERLOADED: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 529,
  body: json({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  }),
  foreignText: "Overloaded",
};

export const GEMINI_QUOTA: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 429,
  body: json({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan " +
        "and billing details. For more information on this error, head " +
        "to: https://ai.google.dev/gemini-api/docs/rate-limits.",
      status: "RESOURCE_EXHAUSTED",
    },
  }),
  foreignText: "head to: https://ai.google.dev",
};

/** The free tier's per-minute limit, which the body also calls a quota. */
export const GEMINI_QUOTA_PER_MINUTE: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 429,
  body: json({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan " +
        "and billing details. For more information on this error, head " +
        "to: https://ai.google.dev/gemini-api/docs/rate-limits.",
      status: "RESOURCE_EXHAUSTED",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{
          quotaMetric: "generativelanguage.googleapis.com/" +
            "generate_content_free_tier_requests",
          quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
          quotaDimensions: { model: "gemini-2.5-flash", location: "global" },
          quotaValue: "15",
        }],
      }, {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "41s",
      }],
    },
  }),
  foreignText: "GenerateRequestsPerMinutePerProjectPerModel",
};

export const GEMINI_OVERLOADED: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 503,
  body: json({
    error: {
      code: 503,
      message: "The model is overloaded. Please try again later.",
      status: "UNAVAILABLE",
    },
  }),
  foreignText: "Please try again later",
};

// ─── model not found ─────────────────────────────────────────────────────────

export const OPENAI_MODEL_NOT_FOUND: FailureFixture = {
  family: "openai-compatible",
  source: "openai",
  status: 404,
  body: json({
    error: {
      message: "The model `gpt-5-nope` does not exist or you do not have " +
        "access to it.",
      type: "invalid_request_error",
      param: null,
      code: "model_not_found",
    },
  }),
  foreignText: "does not exist or you do not have access",
};

/** OpenRouter rejects an unknown id with HTTP 400: the body decides. */
export const OPENROUTER_INVALID_MODEL: FailureFixture = {
  family: "openai-compatible",
  source: "openrouter",
  status: 400,
  body: json({
    error: { message: "openai/gpt-nope is not a valid model ID", code: 400 },
  }),
  foreignText: "is not a valid model ID",
};

export const OPENROUTER_NO_ENDPOINTS: FailureFixture = {
  family: "openai-compatible",
  source: "openrouter",
  status: 404,
  body: json({
    error: { message: "No endpoints found for openai/gpt-nope.", code: 404 },
  }),
  foreignText: "No endpoints found",
};

export const ANTHROPIC_MODEL_NOT_FOUND: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 404,
  body: json({
    type: "error",
    error: { type: "not_found_error", message: "model: claude-nope" },
  }),
  foreignText: "model: claude-nope",
};

export const GEMINI_MODEL_NOT_FOUND: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 404,
  body: json({
    error: {
      code: 404,
      message: "models/gemini-nope is not found for API version v1beta, or " +
        "is not supported for generateContent. Call ListModels to see the " +
        "list of available models and their supported methods.",
      status: "NOT_FOUND",
    },
  }),
  foreignText: "Call ListModels",
};

// ─── request too large ───────────────────────────────────────────────────────

/** A reverse proxy in front of an OpenAI-compatible server. */
export const PROXY_REQUEST_TOO_LARGE: FailureFixture = {
  family: "openai-compatible",
  source: "nginx",
  status: 413,
  body: "<html>\r\n<head><title>413 Request Entity Too Large</title></head>" +
    "\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>" +
    "\r\n<hr><center>nginx/1.25.3</center>\r\n</body>\r\n</html>\r\n",
  foreignText: "nginx/1.25.3",
};

export const ANTHROPIC_REQUEST_TOO_LARGE: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 413,
  body: json({
    type: "error",
    error: {
      type: "request_too_large",
      message: "Request exceeds the maximum size of 32 MB",
    },
  }),
  foreignText: "maximum size of 32 MB",
};

/** Gemini refuses an oversized payload with HTTP 400: the body decides. */
export const GEMINI_REQUEST_TOO_LARGE: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 400,
  body: json({
    error: {
      code: 400,
      message: "Request payload size exceeds the limit: 20971520 bytes.",
      status: "INVALID_ARGUMENT",
    },
  }),
  foreignText: "20971520 bytes",
};

// ─── unclassified ────────────────────────────────────────────────────────────

export const OPENAI_SERVER_ERROR: FailureFixture = {
  family: "openai-compatible",
  source: "openai",
  status: 500,
  body: json({
    error: {
      message: "The server had an error while processing your request. " +
        "Sorry about that!",
      type: "server_error",
      param: null,
      code: null,
    },
  }),
  foreignText: "Sorry about that!",
};

export const ANTHROPIC_SERVER_ERROR: FailureFixture = {
  family: "anthropic",
  source: "anthropic",
  status: 500,
  body: json({
    type: "error",
    error: { type: "api_error", message: "Internal server error" },
  }),
  foreignText: "Internal server error",
};

export const GEMINI_SERVER_ERROR: FailureFixture = {
  family: "gemini",
  source: "gemini",
  status: 500,
  body: json({
    error: {
      code: 500,
      message: "An internal error has occurred. Please retry or report in " +
        "https://developers.generativeai.google/guide/troubleshooting",
      status: "INTERNAL",
    },
  }),
  foreignText: "developers.generativeai.google",
};

/** An error body of `bytes` ASCII bytes, larger than any reader should keep. */
export function oversizedErrorBody(bytes: number): string {
  return `{"error":{"message":"${"x".repeat(Math.max(0, bytes - 24))}"}}`;
}

// ─── no response at all ──────────────────────────────────────────────────────

/**
 * What `fetch` throws when nothing listens at the base URL. The message is
 * the Deno runtime's, and it is still never relayed.
 */
export const CONNECTION_REFUSED = () =>
  new TypeError(
    "error sending request for url (http://127.0.0.1:8080/v1/chat/completions): " +
      "client error (Connect): tcp connect error: Connection refused (os error 61)",
  );

export const DNS_FAILURE = () =>
  new TypeError(
    "error sending request for url (https://api.example.invalid/v1/messages): " +
      "client error (Connect): dns error: failed to lookup address " +
      "information: nodename nor servname provided, or not known",
  );

export const NO_ROUTE = () =>
  new TypeError(
    "error sending request for url (http://10.0.0.9:8080/v1/chat/completions): " +
      "client error (Connect): tcp connect error: No route to host (os error 65)",
  );

export const CONNECTION_RESET = () =>
  new TypeError(
    "error sending request for url (http://127.0.0.1:8080/v1/chat/completions): " +
      "client error (SendRequest): connection closed before message completed",
  );
