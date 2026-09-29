/**
 * The interactive REPL's entry into extensions/friction/: the context
 * normalization its `/friction` command applies before calling
 * `friction/post`, and the receipt type that method returns.
 *
 * Allowed dependencies: this directory's own modules.
 */

export {
  type FrictionPostResult,
  normalizeFrictionContext,
} from "./friction.ts";
