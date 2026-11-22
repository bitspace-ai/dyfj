/**
 * The `[openrouter]` table: which upstream serves an OpenRouter request, and
 * whether the request may fail over or land on an upstream without
 * zero-data-retention guarantees.
 *
 *   [openrouter]
 *   upstream_order = ["Fireworks"]          # provider name or endpoint slug
 *   allow_fallbacks = false
 *   zdr = true
 *
 *   [openrouter.models."deepseek/deepseek-v4.1-flash-1017"]
 *   upstream_order = ["fireworks/fp8"]      # pin one endpoint
 *
 * `upstream_order` is passed to OpenRouter as `provider.order`. A provider
 * name (`Fireworks`) lets OpenRouter pick among that provider's endpoints;
 * a full endpoint slug (`fireworks/fp8`) pins one endpoint, which is what
 * keeps prompt-cache locality across the turns of a long session. `zdr`
 * restricts routing to upstreams with zero-data-retention guarantees.
 *
 * Absent section, absent keys: nothing is sent beyond the existing
 * `max_price`, so the wire request is byte-identical to before.
 */

import { configLabel } from "./toml.ts";

/** One routing policy: the three OpenRouter `provider` fields the operator sets. */
export interface OpenRouterRoutingPolicy {
  /** OpenRouter `provider.order`: provider names or endpoint slugs, in preference order. */
  readonly upstreamOrder?: readonly string[];
  /** OpenRouter `provider.allow_fallbacks`. */
  readonly allowFallbacks?: boolean;
  /** OpenRouter `provider.zdr` (zero data retention). */
  readonly zdr?: boolean;
}

/** The parsed `[openrouter]` table: shared defaults plus per-model overrides. */
export interface OpenRouterConfig {
  readonly defaults?: OpenRouterRoutingPolicy;
  readonly byModel?: Readonly<Record<string, OpenRouterRoutingPolicy>>;
}

/** The most entries `upstream_order` may carry. */
export const MAX_OPENROUTER_UPSTREAM_ORDER = 16;

/**
 * A provider name (`Fireworks`) or an OpenRouter endpoint slug
 * (`fireworks/fp8`): letters, digits, space, `.`, `_`, `/` and `-`, up to 64
 * characters. Whitespace and slash placement are checked separately: the
 * space is allowed inside a name, but neither padding nor an empty segment is
 * a name or a slug.
 */
const UPSTREAM_ENTRY = /^[A-Za-z0-9 ._/-]{1,64}$/;

const OPENROUTER_KEYS: ReadonlySet<string> = new Set([
  "upstream_order",
  "allow_fallbacks",
  "zdr",
  "models",
]);

const POLICY_KEYS: ReadonlySet<string> = new Set([
  "upstream_order",
  "allow_fallbacks",
  "zdr",
]);

function isPlainTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUpstreamOrder(
  value: unknown,
  at: string,
  where: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `config: ${at} must be an array of strings in ${configLabel(where)}`,
    );
  }
  if (value.length === 0) {
    throw new Error(
      `config: ${at} must not be empty in ${configLabel(where)}`,
    );
  }
  if (value.length > MAX_OPENROUTER_UPSTREAM_ORDER) {
    throw new Error(
      `config: ${at} has ${value.length} entries; the limit is ` +
        `${MAX_OPENROUTER_UPSTREAM_ORDER} in ${configLabel(where)}`,
    );
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(
        `config: ${at}[${index}] must be a non-empty string in ${
          configLabel(where)
        }`,
      );
    }
    if (!UPSTREAM_ENTRY.test(entry)) {
      throw new Error(
        `config: ${at}[${index}] "${entry}" is not a provider name or ` +
          `endpoint slug (allowed: letters, digits, space, ".", "_", "/" and ` +
          `"-", up to 64 characters) in ${configLabel(where)}`,
      );
    }
    // UPSTREAM_ENTRY admits a space (provider names like `Together AI` need
    // one), so whitespace needs its own rules: an entry OpenRouter reads as
    // `   `, ` Fireworks ` or `fireworks/ ` names nothing, and would silently
    // match no upstream instead of failing here.
    if (entry !== entry.trim()) {
      throw new Error(
        `config: ${at}[${index}] "${entry}" has leading or trailing ` +
          `whitespace in ${configLabel(where)}`,
      );
    }
    // A slug is `provider[/variant][/region][/tier]`. A leading, trailing or
    // doubled slash leaves a segment that says nothing, and so does a segment
    // that is whitespace alone.
    if (entry.split("/").some((segment) => segment.trim() === "")) {
      throw new Error(
        `config: ${at}[${index}] "${entry}" has an empty path segment in ${
          configLabel(where)
        }`,
      );
    }
    entries.push(entry);
  }
  return Object.freeze(entries);
}

function readBooleanField(
  value: unknown,
  at: string,
  where: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `config: ${at} must be a boolean in ${configLabel(where)}`,
    );
  }
  return value;
}

/** Parse one policy table (the `[openrouter]` table, or one model's override). */
function parseRoutingPolicy(
  values: Record<string, unknown>,
  at: string,
  where: string,
  allowedKeys: ReadonlySet<string>,
): OpenRouterRoutingPolicy {
  for (const key of Object.keys(values)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `config: unknown key ${at}.${key} in ${configLabel(where)}`,
      );
    }
  }
  const policy: {
    upstreamOrder?: readonly string[];
    allowFallbacks?: boolean;
    zdr?: boolean;
  } = {};
  const order = values["upstream_order"];
  if (order !== undefined) {
    policy.upstreamOrder = readUpstreamOrder(order, `${at}.upstream_order`, where);
  }
  const fallbacks = values["allow_fallbacks"];
  if (fallbacks !== undefined) {
    policy.allowFallbacks = readBooleanField(
      fallbacks,
      `${at}.allow_fallbacks`,
      where,
    );
  }
  const zdr = values["zdr"];
  if (zdr !== undefined) {
    policy.zdr = readBooleanField(zdr, `${at}.zdr`, where);
  }
  return Object.freeze(policy);
}

function hasEntries(order: readonly string[] | undefined): boolean {
  return order !== undefined && order.length > 0;
}

/**
 * Refuse a policy that forbids fallbacks without naming the upstreams it
 * means: OpenRouter would then have no eligible upstream at all, or would
 * admit anything, and neither is what the operator asked for.
 */
function refuseFallbacksWithoutOrder(
  policy: OpenRouterRoutingPolicy,
  inherited: readonly string[] | undefined,
  at: string,
  where: string,
): void {
  if (policy.allowFallbacks !== false) return;
  const effective = policy.upstreamOrder ?? inherited;
  if (hasEntries(effective)) return;
  throw new Error(
    `config: ${at}.allow_fallbacks = false needs ${at}.upstream_order in ${
      configLabel(where)
    }`,
  );
}

/**
 * Parse the `[openrouter]` table. Returns null when the table is absent, so
 * every OpenRouter request keeps its exact existing wire shape.
 */
export function parseOpenRouterConfig(
  table: Record<string, unknown> | null,
  where: string,
): OpenRouterConfig | null {
  if (table === null) return null;
  const section = table["openrouter"];
  if (section === undefined) return null;
  if (!isPlainTable(section)) {
    throw new Error(
      `config: [openrouter] must be a table in ${configLabel(where)}`,
    );
  }
  for (const key of Object.keys(section)) {
    if (!OPENROUTER_KEYS.has(key)) {
      throw new Error(
        `config: unknown key openrouter.${key} in ${configLabel(where)}`,
      );
    }
  }
  const defaults = parseRoutingPolicy(
    Object.fromEntries(
      Object.entries(section).filter(([key]) => key !== "models"),
    ),
    "openrouter",
    where,
    POLICY_KEYS,
  );
  refuseFallbacksWithoutOrder(
    defaults,
    undefined,
    "openrouter",
    where,
  );

  const modelsTable = section["models"];
  if (modelsTable === undefined) {
    return Object.freeze({ defaults });
  }
  if (!isPlainTable(modelsTable)) {
    throw new Error(
      `config: [openrouter.models] must be a table in ${configLabel(where)}`,
    );
  }
  const byModel: Record<string, OpenRouterRoutingPolicy> = {};
  for (const [slug, override] of Object.entries(modelsTable)) {
    const at = `openrouter.models."${slug}"`;
    if (slug === "") {
      throw new Error(
        `config: an openrouter.models key must be a non-empty model slug in ${
          configLabel(where)
        }`,
      );
    }
    if (!isPlainTable(override)) {
      throw new Error(
        `config: [${at}] must be a table in ${configLabel(where)}`,
      );
    }
    const policy = parseRoutingPolicy(override, at, where, POLICY_KEYS);
    refuseFallbacksWithoutOrder(
      policy,
      defaults.upstreamOrder,
      at,
      where,
    );
    byModel[slug] = policy;
  }
  return Object.freeze({
    defaults,
    byModel: Object.freeze(byModel),
  });
}

/**
 * The routing policy for `slug`: the per-model override merged field by field
 * over the shared defaults, so a model that names only `zdr` keeps the
 * defaults' `upstream_order`. Undefined when neither names anything, and then
 * the request carries only `max_price`.
 */
export function resolveOpenRouterPolicyForModel(
  config: OpenRouterConfig | undefined,
  slug: string,
): OpenRouterRoutingPolicy | undefined {
  if (config === undefined) return undefined;
  const defaults = config.defaults;
  const override = config.byModel?.[slug];
  if (defaults === undefined && override === undefined) return undefined;
  const upstreamOrder = override?.upstreamOrder ?? defaults?.upstreamOrder;
  const allowFallbacks = override?.allowFallbacks ?? defaults?.allowFallbacks;
  const zdr = override?.zdr ?? defaults?.zdr;
  const policy: {
    upstreamOrder?: readonly string[];
    allowFallbacks?: boolean;
    zdr?: boolean;
  } = {};
  if (upstreamOrder !== undefined) policy.upstreamOrder = upstreamOrder;
  if (allowFallbacks !== undefined) policy.allowFallbacks = allowFallbacks;
  if (zdr !== undefined) policy.zdr = zdr;
  return Object.keys(policy).length === 0 ? undefined : Object.freeze(policy);
}
