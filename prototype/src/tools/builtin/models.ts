/**
 * The `workbench.models` tool (BIT-817): the runtime's active model catalog,
 * as `dyfj models` lists it, with each row's prices. It lets a session whose
 * commands run in the srt sandbox read the catalog it runs under, which the
 * `dyfj` CLI cannot do from there: the sandbox denies the runtime socket.
 *
 * The executor reads only the rows its port returns, and prints only the
 * fields named in `CatalogModelRow`: a row's base URL and API kind, and any
 * config value, are not among them. Read-only; the policy allows it without a
 * prompt.
 */

import { sanitizeBoundaryText } from "../../kernel/mod.ts";
import type { CommandDefinition } from "../definition.ts";

/** The catalog fields the tool shows, one row per model. */
export interface CatalogModelRow {
  slug: string;
  displayName: string;
  provider: string;
  tier: number;
  /** USD per million input tokens, as the catalog prices it. */
  costInput: number;
  /** USD per million output tokens, as the catalog prices it. */
  costOutput: number;
  /** False when the row has no catalog pricing, so routing refuses it. */
  routable: boolean;
  /** True for a model served on this machine. */
  local: boolean;
  /** The provider access category, such as `local` or `aggregator-hosted`. */
  modality: string;
}

/** The catalog as the tool receives it. */
export interface CatalogListing {
  models: readonly CatalogModelRow[];
  /**
   * How many rows the catalog has, when the caller passed only some of
   * them; `models.length` when absent.
   */
  total?: number;
  /**
   * True when the catalog could not be loaded and `models` are the built-in
   * local rows. The reason is not passed on: it is store detail.
   */
  fallback?: boolean;
}

export interface WorkbenchModelsDependencies {
  listModels: () => Promise<CatalogListing>;
}

const FALLBACK_NOTE = "The model catalog could not be loaded, so only the " +
  "built-in local models are listed.";

/** The most rows one listing prints; the rest are counted, not listed. */
export const MAX_LISTED_MODELS = 200;

/** The most UTF-8 bytes a descriptive cell prints. */
const MAX_CELL_BYTES = 120;

/**
 * The most UTF-8 bytes a slug cell prints: room for the widest slug column
 * in the schema (256 characters of up to 4 bytes), so a slug the catalog can
 * hold is printed whole and stays usable as a model id.
 */
const MAX_SLUG_BYTES = 1_024;

/**
 * One catalog string as a cell: line breaks become spaces, other control
 * characters are dropped and the column separator is replaced, so a value
 * cannot add a row or a column.
 */
function cell(value: string, maxBytes = MAX_CELL_BYTES): string {
  return sanitizeBoundaryText(value, maxBytes).replaceAll("|", "/");
}

/** The catalog's price as it stores it, so a small positive price is not shown as zero. */
function price(value: number): string {
  return Number.isFinite(value) ? `$${value}` : "?";
}

/**
 * The listing as the model reads it. A listing with rows is a header line
 * and one line per row, at most `MAX_LISTED_MODELS` of them, preceded by a
 * note when the catalog could not be loaded and followed by a count of the
 * rows left out. An empty catalog is one line that says so, after the
 * fallback note when there is one.
 */
export function formatCatalogListing(listing: CatalogListing): string {
  const lines: string[] = [];
  if (listing.fallback === true) lines.push(FALLBACK_NOTE);
  if (listing.models.length === 0 && (listing.total ?? 0) === 0) {
    lines.push("The model catalog has no active models.");
    return lines.join("\n");
  }
  lines.push(
    "slug | provider | tier | modality | input $/M tokens | " +
      "output $/M tokens | notes | display name",
  );
  for (const m of listing.models.slice(0, MAX_LISTED_MODELS)) {
    const notes = [
      ...(m.local ? ["local"] : []),
      ...(m.routable ? [] : ["unpriced, not routable"]),
    ].join(", ");
    lines.push(
      [
        cell(m.slug, MAX_SLUG_BYTES),
        cell(m.provider),
        `t${m.tier}`,
        cell(m.modality),
        price(m.costInput),
        price(m.costOutput),
        notes,
        cell(m.displayName),
      ].join(" | "),
    );
  }
  const listed = Math.min(listing.models.length, MAX_LISTED_MODELS);
  const omitted = (listing.total ?? listing.models.length) - listed;
  if (omitted > 0) lines.push(`${omitted} more models are not listed.`);
  return lines.join("\n");
}

export function defineWorkbenchModels(
  deps: WorkbenchModelsDependencies,
): CommandDefinition<string> {
  return {
    id: "workbench.models",
    title: "List Workbench Models",
    description:
      "List the Workbench runtime's active model catalog: for up to 200 " +
      "models, the slug, provider, tier, access modality and price per " +
      "million input and output tokens, with long names shortened. Use this instead of running `dyfj models` from a " +
      "shell command, which cannot reach the runtime from inside the " +
      "sandbox. It does not show a model's base URL, API kind or any " +
      "config value.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    permission: {
      effects: ["emit.event"],
      defaultDecision: "allow",
      resources: ["workbench:models"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: async () => formatCatalogListing(await deps.listModels()),
  };
}
