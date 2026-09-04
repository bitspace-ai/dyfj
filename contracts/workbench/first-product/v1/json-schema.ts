/**
 * Bounded JSON Schema Draft 2020-12 subset evaluator.
 *
 * The contract package validates its fixtures with repository-owned code and
 * adds no dependency, so structural validation runs on this evaluator rather
 * than on a general-purpose validator library. It implements exactly the
 * keywords the package schemas use and fails closed on anything else.
 *
 * Fail-closed authoring is decided **at registry construction**, not during
 * evaluation. `auditSchemaDocument` walks every schema-bearing location of
 * every registered document — `$defs`, `properties`, `items`, schema-valued
 * `additionalProperties`, and each branch of `allOf` / `anyOf` / `oneOf` —
 * so a keyword that no instance ever reaches still fails. Evaluation-time
 * checking alone would let an unsupported keyword sleep inside an optional
 * subschema and pass every document that omits that property. The audit
 * never descends into `const` or `enum`, whose values are data rather than
 * schemas.
 *
 * The audit also rejects malformed values for supported keywords. A
 * misspelt shape (`"required": "id"`, `"minItems": "2"`, `"allOf": {}`, an
 * uncompilable `pattern`, an unknown `type` name) would otherwise be
 * silently skipped at evaluation time and quietly assert nothing.
 *
 * Supported keywords: `$ref`, `$defs`, `type`, `enum`, `const`, `required`,
 * `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`,
 * `uniqueItems`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`,
 * `allOf`, `anyOf`, `oneOf`. Annotation-only keywords (`$schema`, `$id`,
 * `title`, `description`, `$comment`) are ignored.
 *
 * Diagnostics are deterministic and value-safe: every finding carries a
 * stable structural rule id, a sanitized JSON pointer, and the keyword that
 * failed — never the failing value. Fixture documents are untrusted input to
 * this evaluator, so a payload byte can never reach a diagnostic line.
 */

// Stable structural rule ids. A negative fixture names one of these when the
// violation it demonstrates is a shape violation rather than a cross-document
// one; the semantic rule ids live in `semantic-rules.ts`.
export const STRUCTURAL_RULE_IDS = [
  "structure.required",
  "structure.type",
  "structure.value-domain",
  "structure.unknown-field",
  "structure.collection",
  "structure.mutual-exclusion",
] as const;

export type StructuralRuleId = (typeof STRUCTURAL_RULE_IDS)[number];

export interface StructuralDiagnostic {
  rule: StructuralRuleId;
  keyword: string;
  path: string;
}

export type SchemaDocument = Record<string, unknown>;

// Keyword-to-rule mapping. Every supported assertion keyword appears here.
// `auditSchemaDocument` decides support for the whole document at
// construction; `evaluate` keeps its own check as defence in depth.
const KEYWORD_RULES: Record<string, StructuralRuleId> = {
  type: "structure.type",
  enum: "structure.value-domain",
  const: "structure.value-domain",
  pattern: "structure.value-domain",
  minLength: "structure.value-domain",
  maxLength: "structure.value-domain",
  minimum: "structure.value-domain",
  maximum: "structure.value-domain",
  required: "structure.required",
  properties: "structure.required",
  additionalProperties: "structure.unknown-field",
  items: "structure.collection",
  minItems: "structure.collection",
  maxItems: "structure.collection",
  uniqueItems: "structure.collection",
  allOf: "structure.mutual-exclusion",
  anyOf: "structure.mutual-exclusion",
  oneOf: "structure.mutual-exclusion",
};

const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "$comment",
]);

// Bounds: a fixture is untrusted input, so evaluation cannot be driven into
// unbounded recursion or unbounded reporting by a crafted document.
const MAX_DEPTH = 64;
const MAX_DIAGNOSTICS = 64;

// Pointer segments are built from document-supplied property names, so they
// are sanitized the same way the repository's scanners sanitize paths: a
// bounded conservative character class, everything else collapsed.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

function safeSegment(segment: string): string {
  return SAFE_SEGMENT.test(segment) ? segment : "?";
}

function pointer(base: string, segment: string | number): string {
  const part = typeof segment === "number"
    ? String(segment)
    : safeSegment(segment);
  return `${base}/${part}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = jsonType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// The JSON type names `type` may name. An unknown name would match no
// instance and silently reject everything, so authoring one fails closed.
const JSON_TYPE_NAMES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);

function malformed(keyword: string, path: string): Error {
  return new Error(
    `malformed schema keyword value: ${keyword} at ${path === "" ? "/" : path}`,
  );
}

function expectString(value: unknown, keyword: string, path: string): void {
  if (typeof value !== "string") throw malformed(keyword, path);
}

function expectBoolean(value: unknown, keyword: string, path: string): void {
  if (typeof value !== "boolean") throw malformed(keyword, path);
}

function expectNumber(value: unknown, keyword: string, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformed(keyword, path);
  }
}

function expectCount(value: unknown, keyword: string, path: string): void {
  expectNumber(value, keyword, path);
  if (!Number.isInteger(value as number) || (value as number) < 0) {
    throw malformed(keyword, path);
  }
}

function expectSchemaMap(
  value: unknown,
  keyword: string,
  path: string,
): Record<string, unknown> {
  if (!isObject(value)) throw malformed(keyword, path);
  return value;
}

function expectSchemaArray(
  value: unknown,
  keyword: string,
  path: string,
): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw malformed(keyword, path);
  }
  return value;
}

/**
 * Audits a value that must be a subschema. A non-schema in a schema-bearing
 * slot is reported as a malformed keyword value, so keyword misuse keeps one
 * authoring-error vocabulary regardless of which slot it appears in.
 */
function auditSubschema(value: unknown, keyword: string, path: string): void {
  if (typeof value !== "boolean" && !isObject(value)) {
    throw malformed(keyword, path);
  }
  auditSchemaDocument(value, path);
}

/**
 * Unconditional authoring audit of one schema node and everything beneath
 * it. Runs at registry construction over every registered document, so a
 * dormant subschema is audited exactly like an actively evaluated one.
 *
 * Paths name repository-owned schema files rather than untrusted documents,
 * but segments are sanitized anyway to keep every diagnostic in this module
 * bounded and value-safe.
 */
export function auditSchemaDocument(node: unknown, path = ""): void {
  if (typeof node === "boolean") return;
  if (!isObject(node)) {
    throw new Error(
      `schema node is neither an object nor a boolean at ${
        path === "" ? "/" : path
      }`,
    );
  }
  for (const [keyword, value] of Object.entries(node)) {
    const at = pointer(path, keyword);
    switch (keyword) {
      // Annotations: shape only, never traversed as schemas.
      case "$schema":
      case "$id":
      case "$ref":
      case "title":
      case "description":
      case "$comment":
        expectString(value, keyword, at);
        break;
      // Maps of name to schema. The keys are author-chosen names, never
      // keywords, so only the values are audited.
      case "$defs":
      case "properties": {
        const entries = expectSchemaMap(value, keyword, at);
        for (const [name, subschema] of Object.entries(entries)) {
          auditSubschema(subschema, keyword, pointer(at, name));
        }
        break;
      }
      case "items":
      case "additionalProperties":
        auditSubschema(value, keyword, at);
        break;
      case "allOf":
      case "anyOf":
      case "oneOf": {
        const branches = expectSchemaArray(value, keyword, at);
        branches.forEach((branch, index) => {
          auditSubschema(branch, keyword, pointer(at, index));
        });
        break;
      }
      case "required": {
        if (!Array.isArray(value)) throw malformed(keyword, at);
        for (const name of value) {
          if (typeof name !== "string") throw malformed(keyword, at);
        }
        break;
      }
      case "type": {
        const names = Array.isArray(value) ? value : [value];
        if (names.length === 0) throw malformed(keyword, at);
        for (const name of names) {
          if (typeof name !== "string" || !JSON_TYPE_NAMES.has(name)) {
            throw malformed(keyword, at);
          }
        }
        break;
      }
      case "enum":
        // Enum members are data, not schemas: their shape is the author's
        // business and they are never traversed.
        if (!Array.isArray(value) || value.length === 0) {
          throw malformed(keyword, at);
        }
        break;
      case "const":
        // Any JSON value is a legal const, and it is data, not a schema.
        break;
      case "pattern":
        expectString(value, keyword, at);
        try {
          new RegExp(value as string);
        } catch {
          throw malformed(keyword, at);
        }
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        expectCount(value, keyword, at);
        break;
      case "minimum":
      case "maximum":
        expectNumber(value, keyword, at);
        break;
      case "uniqueItems":
        expectBoolean(value, keyword, at);
        break;
      default:
        throw new Error(`unsupported schema keyword: ${keyword} at ${at}`);
    }
  }
}

/**
 * A set of schema documents addressed by `$id`, able to validate a value
 * against any of them. Cross-document `$ref` resolution is exact-id only:
 * there is no network fetch and no filesystem fallback.
 *
 * Construction audits every registered document in full, so a registry that
 * exists is a registry whose schemas are entirely supported and well formed.
 */
export class SchemaRegistry {
  readonly #documents = new Map<string, SchemaDocument>();

  constructor(documents: readonly SchemaDocument[]) {
    for (const document of documents) {
      const id = document["$id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("schema document is missing a string $id");
      }
      if (this.#documents.has(id)) {
        throw new Error("schema documents declare a duplicate $id");
      }
      // Audited before registration: an unsupported or malformed keyword
      // anywhere in the document — including a branch no instance reaches —
      // prevents the registry from existing at all.
      auditSchemaDocument(document);
      this.#documents.set(id, document);
    }
  }

  get ids(): readonly string[] {
    return [...this.#documents.keys()];
  }

  document(id: string): SchemaDocument {
    const document = this.#documents.get(id);
    if (!document) throw new Error(`unknown schema document id: ${id}`);
    return document;
  }

  validate(rootId: string, value: unknown): StructuralDiagnostic[] {
    const found: StructuralDiagnostic[] = [];
    this.#evaluate(this.document(rootId), rootId, value, "", found, 0);
    return found;
  }

  /**
   * Resolves a `$ref` to its schema plus the document id that owns it, so a
   * nested `#/$defs/...` reference inside the target resolves against the
   * target's own document rather than the referring one.
   */
  #resolve(
    reference: string,
    baseId: string,
  ): { schema: unknown; documentId: string } {
    const hash = reference.indexOf("#");
    const uri = hash === -1 ? reference : reference.slice(0, hash);
    const fragment = hash === -1 ? "" : reference.slice(hash + 1);
    const documentId = uri.length === 0 ? baseId : uri;
    let target: unknown = this.document(documentId);
    if (fragment.length === 0) return { schema: target, documentId };
    if (!fragment.startsWith("/")) {
      throw new Error("only JSON-pointer schema fragments are supported");
    }
    for (const rawSegment of fragment.slice(1).split("/")) {
      const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObject(target)) {
        throw new Error(`unresolvable schema reference: ${reference}`);
      }
      target = target[segment];
    }
    if (target === undefined) {
      throw new Error(`unresolvable schema reference: ${reference}`);
    }
    return { schema: target, documentId };
  }

  #evaluate(
    schema: unknown,
    documentId: string,
    value: unknown,
    path: string,
    found: StructuralDiagnostic[],
    depth: number,
  ): void {
    if (depth > MAX_DEPTH) {
      throw new Error("schema evaluation exceeded its depth bound");
    }
    if (found.length >= MAX_DIAGNOSTICS) return;
    if (typeof schema === "boolean") {
      if (!schema) {
        found.push({ rule: "structure.type", keyword: "false", path });
      }
      return;
    }
    if (!isObject(schema)) {
      throw new Error("schema node is neither an object nor a boolean");
    }

    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATION_KEYWORDS.has(keyword) && !(keyword in KEYWORD_RULES)) {
        throw new Error(`unsupported schema keyword: ${keyword}`);
      }
    }

    const reference = schema["$ref"];
    if (typeof reference === "string") {
      const resolved = this.#resolve(reference, documentId);
      this.#evaluate(
        resolved.schema,
        resolved.documentId,
        value,
        path,
        found,
        depth + 1,
      );
    }

    const report = (keyword: string, at = path): void => {
      if (found.length >= MAX_DIAGNOSTICS) return;
      found.push({ rule: KEYWORD_RULES[keyword]!, keyword, path: at });
    };

    if ("type" in schema) {
      const expected = schema["type"];
      const options = Array.isArray(expected) ? expected : [expected];
      const matched = options.some((option) =>
        typeof option === "string" && typeMatches(value, option)
      );
      if (!matched) {
        report("type");
        return;
      }
    }

    if ("const" in schema && !sameValue(value, schema["const"])) {
      report("const");
    }

    if ("enum" in schema) {
      const options = schema["enum"];
      if (!Array.isArray(options)) {
        throw new Error("enum must be an array");
      }
      if (!options.some((option) => sameValue(value, option))) {
        report("enum");
      }
    }

    if (typeof value === "string") {
      const pattern = schema["pattern"];
      if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
        report("pattern");
      }
      const minLength = schema["minLength"];
      if (typeof minLength === "number" && value.length < minLength) {
        report("minLength");
      }
      const maxLength = schema["maxLength"];
      if (typeof maxLength === "number" && value.length > maxLength) {
        report("maxLength");
      }
    }

    if (typeof value === "number") {
      const minimum = schema["minimum"];
      if (typeof minimum === "number" && value < minimum) report("minimum");
      const maximum = schema["maximum"];
      if (typeof maximum === "number" && value > maximum) report("maximum");
    }

    if (Array.isArray(value)) {
      const minItems = schema["minItems"];
      if (typeof minItems === "number" && value.length < minItems) {
        report("minItems");
      }
      const maxItems = schema["maxItems"];
      if (typeof maxItems === "number" && value.length > maxItems) {
        report("maxItems");
      }
      if (schema["uniqueItems"] === true) {
        const seen = new Set<string>();
        for (const entry of value) {
          const key = JSON.stringify(entry);
          if (seen.has(key)) {
            report("uniqueItems");
            break;
          }
          seen.add(key);
        }
      }
      if ("items" in schema) {
        for (let index = 0; index < value.length; index++) {
          this.#evaluate(
            schema["items"],
            documentId,
            value[index],
            pointer(path, index),
            found,
            depth + 1,
          );
        }
      }
    }

    if (isObject(value)) {
      const required = schema["required"];
      if (Array.isArray(required)) {
        for (const name of required) {
          if (typeof name === "string" && !(name in value)) {
            report("required", pointer(path, name));
          }
        }
      }
      const properties = isObject(schema["properties"])
        ? schema["properties"]
        : undefined;
      if (properties) {
        for (const [name, subschema] of Object.entries(properties)) {
          if (name in value) {
            this.#evaluate(
              subschema,
              documentId,
              value[name],
              pointer(path, name),
              found,
              depth + 1,
            );
          }
        }
      }
      if ("additionalProperties" in schema) {
        const additional = schema["additionalProperties"];
        for (const name of Object.keys(value)) {
          if (properties && name in properties) continue;
          if (additional === false) {
            report("additionalProperties", pointer(path, name));
            continue;
          }
          if (additional === true) continue;
          this.#evaluate(
            additional,
            documentId,
            value[name],
            pointer(path, name),
            found,
            depth + 1,
          );
        }
      }
    }

    const allOf = schema["allOf"];
    if (Array.isArray(allOf)) {
      for (const branch of allOf) {
        this.#evaluate(branch, documentId, value, path, found, depth + 1);
      }
    }

    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword];
      if (!Array.isArray(branches)) continue;
      let matches = 0;
      for (const branch of branches) {
        const branchFindings: StructuralDiagnostic[] = [];
        this.#evaluate(
          branch,
          documentId,
          value,
          path,
          branchFindings,
          depth + 1,
        );
        if (branchFindings.length === 0) matches++;
      }
      const satisfied = keyword === "oneOf" ? matches === 1 : matches >= 1;
      if (!satisfied) report(keyword);
    }
  }
}
