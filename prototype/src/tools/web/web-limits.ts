/** Per-call and per-turn ceilings shared by the web search and fetch tools. */

export const MAX_SEARCH_CALLS_PER_TURN = 3;
export const MAX_FETCH_CALLS_PER_TURN = 5;
export const MAX_FETCH_DOWNLOAD_BYTES = 1024 * 1024; // 1 MB
export const MAX_EXTRACTED_CHARS_PER_FETCH = 40_000;
export const MAX_EXTRACTED_CHARS_PER_TURN = 100_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_SESSION_TURNS_CAP = 100;
