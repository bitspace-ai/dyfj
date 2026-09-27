/**
 * `schema.equivalence`: the fresh-install path (`current/` then `catalog/`)
 * and the upgrade path (`history/` then `migrations/`) must produce the same
 * structure (`specs/02-data-layer.md` section 4). Each sequence is applied to
 * its own disposable Dolt repository, both are described from
 * `information_schema`, and any difference in tables, columns, types,
 * nullability, defaults, ON UPDATE clauses, indexes, enums, constraints
 * (foreign-key references and rules included) or
 * check constraints fails. Catalog data is not compared.
 */

import {
  assertSchemaApplyPlan,
  readSchemaApplyPlan,
  withSchemaRepository,
} from "./dolt-apply.ts";
import { describeSchema, type SchemaDescription } from "./introspect.ts";

type Keyed = { name: string };

function keyed<T extends Keyed>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

/** Compare two named collections field by field, reporting each difference. */
function compareNamed<T extends Keyed>(
  path: string,
  left: readonly T[],
  right: readonly T[],
  differences: string[],
): void {
  const a = keyed(left);
  const b = keyed(right);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name);
    const y = b.get(name);
    if (x === undefined) {
      differences.push(`${path}.${name}: only in history + migrations`);
      continue;
    }
    if (y === undefined) {
      differences.push(`${path}.${name}: only in current + catalog`);
      continue;
    }
    for (const field of Object.keys(x) as (keyof T)[]) {
      if (field === "name") continue;
      if (show(x[field]) !== show(y[field])) {
        differences.push(
          `${path}.${name}.${String(field)}: current + catalog ${
            show(x[field])
          }, history + migrations ${show(y[field])}`,
        );
      }
    }
  }
}

/** Every structural difference between two descriptions; empty when equal. */
export function schemaDifferences(
  current: SchemaDescription,
  replayed: SchemaDescription,
): string[] {
  const differences: string[] = [];
  const a = keyed(current.tables);
  const b = keyed(replayed.tables);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name);
    const y = b.get(name);
    if (x === undefined) {
      differences.push(`${name}: only in history + migrations`);
      continue;
    }
    if (y === undefined) {
      differences.push(`${name}: only in current + catalog`);
      continue;
    }
    for (const field of ["type", "engine", "collation"] as const) {
      if (x[field] !== y[field]) {
        differences.push(
          `${name}.${field}: current + catalog ${show(x[field])}, ` +
            `history + migrations ${show(y[field])}`,
        );
      }
    }
    compareNamed(`${name}.columns`, x.columns, y.columns, differences);
    compareNamed(`${name}.indexes`, x.indexes, y.indexes, differences);
    compareNamed(
      `${name}.constraints`,
      x.constraints,
      y.constraints,
      differences,
    );
    compareNamed(`${name}.checks`, x.checks, y.checks, differences);
  }
  return differences;
}

export async function checkSchemaEquivalence(
  signal?: AbortSignal,
): Promise<string[]> {
  const schemaDir = new URL("./", import.meta.url);
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  const current = await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "current + catalog",
    signal,
    (repository) => describeSchema(repository, signal),
  );
  const replayed = await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "history + migrations",
    signal,
    (repository) => describeSchema(repository, signal),
  );
  return schemaDifferences(current, replayed);
}

if (import.meta.main) {
  const differences = await checkSchemaEquivalence();
  if (differences.length > 0) {
    console.error(
      "schema.equivalence: current + catalog and history + migrations " +
        "produce different structures:",
    );
    for (const difference of differences) console.error(`  ${difference}`);
    console.error(
      "Fold every migration into schema/current/, or add the migration that " +
        "brings an existing database to the current baseline.",
    );
    Deno.exit(1);
  }
  console.log("schema.equivalence: structures match.");
}
