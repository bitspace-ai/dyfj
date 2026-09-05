/**
 * Workbench first-product semantic contract package — entry point.
 *
 * This module is the single documented entry point of the package at
 * `contracts/workbench/first-product/v1`. It loads the package schemas,
 * validates a corpus document structurally and then semantically, and
 * exposes the stable rule inventory the fixtures name.
 *
 * What the package is: a versioned, machine-readable statement of the
 * first-product domain, lifecycle, event, projection, receipt,
 * route-control, label, claim-source, and authority semantics, plus the
 * validator that decides whether a document satisfies them.
 *
 * What the package is not: runtime authority. It implements no persistence,
 * routing, process control, interface, or provider integration, and it does
 * not displace the repository's Dolt DDL as the canonical data-layer schema
 * for implemented durable state. Validating a document here proves the
 * document; it proves nothing about a running system.
 *
 * Validation order is deliberate and observable: structural findings gate
 * semantic ones. A document whose shape is wrong is reported under a
 * structural rule only, because cross-document rules cannot draw a truthful
 * conclusion from a malformed document.
 */

import {
  type SchemaDocument,
  SchemaRegistry,
  STRUCTURAL_RULE_IDS,
  type StructuralRuleId,
} from "./json-schema.ts";
import {
  checkSemantics,
  type Corpus,
  SEMANTIC_RULE_IDS,
  type SemanticRuleId,
} from "./semantic-rules.ts";

export { STRUCTURAL_RULE_IDS } from "./json-schema.ts";
export {
  REQUIRED_DEFERRALS,
  RUN_STATES,
  SEMANTIC_RULE_IDS,
  TASK_STATES,
} from "./semantic-rules.ts";
export type { Corpus } from "./semantic-rules.ts";

/** The one version this package speaks. */
export const PACKAGE_VERSION = "workbench.first-product/v1";

/** The corpus document schema every fixture validates against. */
export const CORPUS_SCHEMA_ID =
  "urn:dyfj:contracts:workbench:first-product:v1:corpus";

export const SCHEMA_FILES = [
  "common.schema.json",
  "domain.schema.json",
  "events.schema.json",
  "views.schema.json",
  "corpus.schema.json",
] as const;

/** Every stable rule id a fixture may name, structural first. */
export const RULE_IDS: readonly (StructuralRuleId | SemanticRuleId)[] = [
  ...STRUCTURAL_RULE_IDS,
  ...SEMANTIC_RULE_IDS,
];

export interface Diagnostic {
  rule: string;
  path: string;
  detail: string;
  entity?: string;
}

export interface ValidationResult {
  accepted: boolean;
  diagnostics: Diagnostic[];
  /** Distinct rule ids reported, in first-seen order. */
  rules: string[];
}

function packageUrl(relative: string): URL {
  return new URL(relative, import.meta.url);
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(url));
}

/** Loads the package schema documents into an exact-id resolver. */
export async function loadSchemaRegistry(): Promise<SchemaRegistry> {
  const documents: SchemaDocument[] = [];
  for (const file of SCHEMA_FILES) {
    const document = await readJson(packageUrl(`./schemas/${file}`));
    if (typeof document !== "object" || document === null) {
      throw new Error(`schema file is not an object: ${file}`);
    }
    documents.push(document as SchemaDocument);
  }
  return new SchemaRegistry(documents);
}

/**
 * Validates one corpus document. Structural diagnostics suppress semantic
 * ones: a malformed document is reported under its structural rule and no
 * cross-document conclusion is drawn from it.
 */
export function validateCorpus(
  registry: SchemaRegistry,
  document: unknown,
): ValidationResult {
  const structural = registry.validate(CORPUS_SCHEMA_ID, document);
  const diagnostics: Diagnostic[] = structural.map((finding) => ({
    rule: finding.rule,
    path: finding.path === "" ? "/" : finding.path,
    detail: `document shape rejected by the ${finding.keyword} constraint`,
  }));
  if (diagnostics.length === 0) {
    for (const finding of checkSemantics(document as Corpus)) {
      diagnostics.push(
        finding.entity === undefined
          ? { rule: finding.rule, path: finding.path, detail: finding.detail }
          : {
            rule: finding.rule,
            path: finding.path,
            detail: finding.detail,
            entity: finding.entity,
          },
      );
    }
  }
  const rules: string[] = [];
  for (const diagnostic of diagnostics) {
    if (!rules.includes(diagnostic.rule)) rules.push(diagnostic.rule);
  }
  return { accepted: diagnostics.length === 0, diagnostics, rules };
}

export interface Fixture {
  /** Fixture file name, without directory. */
  name: string;
  kind: "positive" | "negative";
  document: unknown;
}

interface DerivedFixtureMutation {
  op: "add" | "copy" | "remove" | "replace";
  path: string;
  from?: string;
  value?: unknown;
}

interface DerivedFixtureDocument {
  fixture_kind: "derived-corpus";
  base: string;
  title?: string;
  expectation: Corpus["expectation"];
  mutations: DerivedFixtureMutation[];
}

function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) {
    throw new Error("derived fixture uses an invalid JSON pointer");
  }
  return pointer.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
}

function pointerParent(
  document: unknown,
  pointer: string,
): { parent: Record<string, unknown> | unknown[]; key: string } {
  const segments = pointerSegments(pointer);
  const key = segments.pop();
  if (key === undefined) throw new Error("derived fixture pointer is empty");
  let current = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error("derived fixture pointer does not resolve");
    }
  }
  if (
    !Array.isArray(current) &&
    (typeof current !== "object" || current === null)
  ) {
    throw new Error("derived fixture pointer has no container");
  }
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function pointerValue(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error("derived fixture copy source does not resolve");
    }
  }
  return current;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyDerivedMutation(
  document: Record<string, unknown>,
  mutation: DerivedFixtureMutation,
): void {
  const { parent, key } = pointerParent(document, mutation.path);
  const value = mutation.op === "remove"
    ? undefined
    : mutation.op === "copy"
    ? cloneJson(pointerValue(document, mutation.from ?? ""))
    : cloneJson(mutation.value);
  if (Array.isArray(parent)) {
    if (mutation.op === "remove") {
      parent.splice(Number(key), 1);
    } else if (key === "-") {
      parent.push(value);
    } else if (mutation.op === "add") {
      parent.splice(Number(key), 0, value);
    } else {
      parent[Number(key)] = value;
    }
    return;
  }
  if (mutation.op === "remove") delete parent[key];
  else parent[key] = value;
}

function isDerivedFixture(value: unknown): value is DerivedFixtureDocument {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["fixture_kind"] === "derived-corpus";
}

async function materializeFixture(
  document: unknown,
): Promise<unknown> {
  if (!isDerivedFixture(document)) return document;
  const base = cloneJson(
    await readJson(packageUrl(`./fixtures/positive/${document.base}`)),
  ) as Record<string, unknown>;
  base["title"] = document.title;
  base["expectation"] = document.expectation;
  for (const mutation of document.mutations) {
    applyDerivedMutation(base, mutation);
  }
  return base;
}

/**
 * Loads the package fixtures in deterministic file-name order. Fixtures are
 * synthetic: they carry no real credential, provider payload, or private
 * material.
 */
export async function loadFixtures(
  kind: "positive" | "negative",
): Promise<Fixture[]> {
  const directory = packageUrl(`./fixtures/${kind}/`);
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".json")) names.push(entry.name);
  }
  names.sort();
  const fixtures: Fixture[] = [];
  for (const name of names) {
    const document = await readJson(new URL(name, directory));
    fixtures.push({
      name,
      kind,
      document: await materializeFixture(document),
    });
  }
  return fixtures;
}

/** Deterministic, value-free one-line rendering of a diagnostic. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const entity = diagnostic.entity === undefined
    ? ""
    : ` entity=${diagnostic.entity}`;
  return `${diagnostic.rule} at ${diagnostic.path}${entity}: ${diagnostic.detail}`;
}
