/**
 * kernel/ — layer L0: pure, shared helpers with one implementation each.
 *
 * Responsibility: UTF-8 byte bounding, code-point prefixes, terminal escape
 * stripping, boundary-text sanitizing, the shared file-stat shape, ULID/trace/span IDs, canonical JSON,
 * the time-bounded regex matcher, lexical path checks, credential-shape
 * detection and scrubbing, and the `Clock` port
 * with its system adapter. Helpers here hold no runtime policy: callers choose
 * limits, markers, and error types.
 *
 * Allowed dependencies: other kernel/ modules, the platform, and third-party
 * packages. Nothing from any other runtime layer (specs/01-architecture.md
 * §3); the arch.imports lane enforces the direction.
 */
export { stripAnsiEscapes } from "./ansi.ts";
export { sanitizeBoundaryText } from "./boundary-text.ts";
export {
  BoundedMatcher,
  DEFAULT_REGEX_BUDGET_MS,
  MAX_PATTERN_LENGTH,
  RegexBudgetExceeded,
  RegexUnavailable,
} from "./bounded-regex.ts";
export {
  canonicalJson,
  MAX_CANONICAL_JSON_CHARACTERS,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_ENTRIES,
} from "./canonical-json.ts";
export { type Clock, systemClock } from "./clock.ts";
export { type FileStat, fileStat, hasVerifiableIdentity } from "./file-stat.ts";
export { takeCodePointPrefix } from "./code-points.ts";
export { generateSpanId, generateTraceId, generateULID } from "./ids.ts";
export { hasDotPathComponent, pathFreeReason } from "./lexical-path.ts";
export {
  containsSensitiveShape,
  SENSITIVE_PLACEHOLDER,
  scrubSensitiveShapes,
} from "./sensitive-shapes.ts";
export {
  clipToUtf8Bytes,
  utf8ByteLengthWithinLimit,
  utf8SafePrefix,
} from "./utf8.ts";
