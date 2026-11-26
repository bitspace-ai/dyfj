/**
 * Bounds shared by the textual tool-call markup readers and the streaming
 * presenter, so the parsers for each markup dialect apply one set of limits.
 */
import { MAX_OPENAI_RESPONSE_BYTES } from "./response-bounds.ts";

/** Most whitespace characters a markup tag may hold between its parts. */
export const MAX_TEXT_TOOL_WRAPPER_WHITESPACE = 32;

/** Most markup candidates (function, parameter or block elements) parsed. */
export const MAX_TEXT_TOOL_MARKUP_CANDIDATES = 64;

/** Most unparsed-markup markers reported in a result's count. */
export const MAX_UNPARSED_TOOL_CALL_MARKERS = 64;

/**
 * Equal-valued character bound for the OpenAI adapter's 4 MiB response-byte
 * ceiling. UTF-8 decoding cannot produce more UTF-16 code units than input
 * bytes, and JSON unescaping only contracts the representation, so model text
 * from an accepted response fits this whole-text bound.
 */
export const MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS = MAX_OPENAI_RESPONSE_BYTES;
