/**
 * Response ceilings for the OpenAI-compatible adapter. The text tool-call
 * scan bound is defined against the byte ceiling, so both live here.
 */

export const MAX_OPENAI_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_OPENAI_RESPONSE_CHUNKS = 8_192;
export const MAX_OPENAI_RESPONSE_READS = 16_384;
