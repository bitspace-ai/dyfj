/**
 * Source parser for the arch.imports lane, on Node (decision D32).
 *
 * A module's TypeScript is stripped with Node's `module.stripTypeScriptTypes`
 * in `strip` mode, which replaces every type with whitespace and so keeps
 * every offset, line and column of the source. The result is plain
 * JavaScript, parsed as ESTree with `acorn`. Neither step is a hand-written
 * lexer.
 *
 * Stripping erases what the lane must still see in type positions: type-only
 * imports and re-exports (`import type`, `export type ... from`), import
 * types (`typeof import("...")`), and string literal types. Those are
 * recovered from the erased spans, which `acorn`'s tokenizer reads:
 * - an `import type` or `export type { ... } from` statement is parsed on its
 *   own, with its `type` keyword blanked, at its original offset, and joins
 *   the program as a type-only declaration;
 * - `import("...")` becomes a `TSImportType` node with a `Literal` argument;
 * - every other string becomes a `Literal` node.
 *
 * `moduleFacts` walks the result with the lane's visitors (formerly a
 * `deno lint` plugin), with the same reports and the same positions:
 * - every import, re-export, dynamic `import()` and import type, as an
 *   import reference for the graph, type-only ones marked;
 * - every dynamic `import()` expression, literal or not;
 * - every direct read of the process environment: `Deno.env`, `process.env`
 *   (including `globalThis.` forms and computed `["env"]`), `.env` on any
 *   default, namespace or `default` import of `node:process` and on a `const`
 *   alias of `Deno` or `process`, destructuring `env` out of any of those,
 *   importing `env` from `node:process`, and re-exporting from
 *   `node:process`;
 * - every string literal, identifier object key, and non-computed member name
 *   that is exactly a `DYFJ_*` environment key;
 * - the specifier of every non-relative import, re-export, dynamic `import()`
 *   and import type;
 * - every string literal, and the leading text of every template literal,
 *   that begins with an SQL write statement (`INSERT INTO`, `REPLACE INTO`,
 *   `UPDATE`, `DELETE FROM`, `TRUNCATE`, table or database DDL,
 *   `CALL DOLT_...`), in upper case as the codebase writes SQL. SQL assembled
 *   from non-literal pieces is out of its reach.
 */

import { stripTypeScriptTypes } from "node:module";
import process from "node:process";
import { type Comment, parse, type Token, tokenizer, tokTypes } from "acorn";

// acorn's tokens carry their value at runtime; its type declarations omit it.
type ValueToken = Token & { value: unknown };

// An ESTree node as acorn builds it; the visitors read it structurally.
// deno-lint-ignore no-explicit-any
type Node = any;

/** An import of another module, for the graph. */
export interface ImportReference {
  specifier: string;
  line: number;
  dynamic: boolean;
  typeOnly: boolean;
}

export interface ModuleFacts {
  imports: ImportReference[];
  /** Every `import()`: its literal specifier, or `null` when not literal. */
  dynamicImports: { specifier: string | null; line: number }[];
  envAccesses: { line: number; via: string }[];
  dyfjKeys: { line: number; key: string }[];
  packageImports: { line: number; specifier: string }[];
  sqlWrites: { line: number; statement: string }[];
}

const ACORN = { ecmaVersion: "latest", sourceType: "module" } as const;

/**
 * Node's type stripping, offset for offset. It is experimental in Node 26 and
 * warns on first use; that one warning is dropped for this call only.
 */
export function stripTypes(source: string): string {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("stripTypeScriptTypes")) return;
    return (emitWarning as (...args: unknown[]) => void).call(
      process,
      warning,
      ...rest,
    );
  }) as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emitWarning;
  }
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Maximal spans the stripper erased, joined across whitespace and comments
 * that sit between erased characters.
 */
function erasedSpans(
  original: string,
  stripped: string,
  comments: readonly Comment[],
): { start: number; end: number }[] {
  const inComment = new Uint8Array(original.length);
  for (const comment of comments) inComment.fill(1, comment.start, comment.end);
  const spans: { start: number; end: number }[] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== stripped[i]) {
      if (start < 0) start = i;
      end = i + 1;
    } else if (start >= 0 && !isBlank(original[i]!) && !inComment[i]) {
      spans.push({ start, end });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ start, end });
  return spans;
}

function lineIndex(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function isKeyword(token: ValueToken | undefined, keyword: string): boolean {
  return token?.type.keyword === keyword;
}

function isName(token: ValueToken | undefined, name: string): boolean {
  return token?.type === tokTypes.name && token.value === name;
}

/**
 * The index of the specifier string that ends the type-only statement
 * starting at `from`, or -1 when it has none (`export type { A };`).
 */
function statementSource(tokens: readonly ValueToken[], from: number): number {
  for (let i = from + 2; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === tokTypes.semi) return -1;
    if (isKeyword(token, "import") || isKeyword(token, "export")) return -1;
    if (isName(token, "from") && tokens[i + 1]?.type === tokTypes.string) {
      return i + 1;
    }
  }
  return -1;
}

interface Parsed {
  program: Node;
  /** Recovered type-position nodes outside statements. */
  typeNodes: Node[];
  /** Declarations recovered from erased `import type` / `export type`. */
  typeOnly: Set<Node>;
}

/** Parses a module; throws when it does not strip or parse. */
export function parseModule(source: string): Parsed {
  const stripped = stripTypes(source);
  const comments: Comment[] = [];
  const program = parse(stripped, {
    ...ACORN,
    locations: true,
    onComment: comments,
  }) as Node;
  const lineOf = lineIndex(source);
  const blank = source.replace(/[^\n]/g, " ");
  const at = (start: number, end: number) => ({
    start,
    end,
    loc: { start: { line: lineOf(start) }, end: { line: lineOf(end) } },
  });
  const literal = (token: ValueToken) => ({
    type: "Literal",
    value: token.value,
    raw: source.slice(token.start, token.end),
    ...at(token.start, token.end),
  });
  const typeNodes: Node[] = [];
  const typeOnly = new Set<Node>();
  for (const span of erasedSpans(source, stripped, comments)) {
    const tokens = [
      ...tokenizer(source.slice(span.start, span.end), ACORN),
    ].map((token) => {
      // Offsets into the module, not the span.
      token.start += span.start;
      token.end += span.start;
      return token as ValueToken;
    });
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const next = tokens[i + 1];
      const statement = isName(next, "type") &&
        (isKeyword(token, "import") ||
          (isKeyword(token, "export") &&
            (tokens[i + 2]?.type === tokTypes.braceL ||
              tokens[i + 2]?.type === tokTypes.star)));
      if (statement) {
        const end = statementSource(tokens, i);
        if (end < 0) continue;
        const last = tokens[end]!;
        const text = source.slice(token.start, next!.start) +
          " ".repeat(next!.end - next!.start) +
          source.slice(next!.end, last.end);
        const isolated = blank.slice(0, token.start) + text +
          blank.slice(last.end);
        const declaration =
          (parse(isolated, { ...ACORN, locations: true }) as Node)
            .body[0];
        program.body.push(declaration);
        typeOnly.add(declaration);
        i = end;
      } else if (
        isKeyword(token, "import") && next?.type === tokTypes.parenL &&
        tokens[i + 2]?.type === tokTypes.string
      ) {
        const argument = tokens[i + 2]!;
        typeNodes.push({
          type: "TSImportType",
          argument: literal(argument),
          ...at(token.start, tokens[i + 3]?.end ?? argument.end),
        });
        i += 2;
      } else if (token.type === tokTypes.string) {
        typeNodes.push(literal(token));
      }
    }
  }
  program.body.sort((a: Node, b: Node) => a.start - b.start);
  return { program, typeNodes, typeOnly };
}

// ---------------------------------------------------------------------------
// Visitors

const ENV_OWNERS = new Set(["Deno", "process"]);
const PROCESS_MODULES = new Set(["node:process", "process"]);
const DYFJ_KEY = /^DYFJ_[A-Za-z0-9_]+$/;
const SQL_WRITE =
  /^\s*(INSERT\s+INTO|REPLACE\s+INTO|UPDATE\s|DELETE\s+FROM|TRUNCATE\s|(?:CREATE|DROP|ALTER)\s+(?:TABLE|DATABASE)|CALL\s+DOLT_)/;

function propertyName(node: Node): string | undefined {
  if (node.computed) {
    const property = node.property;
    if (property?.type === "Literal" && typeof property.value === "string") {
      return property.value;
    }
    // A template literal with no substitutions: ``Deno[`env`]``.
    if (
      property?.type === "TemplateLiteral" &&
      (property.expressions ?? []).length === 0
    ) {
      return property.quasis?.[0]?.value?.cooked;
    }
    return undefined;
  }
  return node.property?.type === "Identifier" ? node.property.name : undefined;
}

/**
 * `Deno` / `process`, bare, as `globalThis.Deno` / `globalThis.process`, or
 * through a local alias (`aliases`: binding name → owner).
 */
function envOwner(
  node: Node,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  if (node?.type === "Identifier") {
    const alias = aliases.get(node.name);
    if (alias !== undefined) return alias === "globalThis" ? undefined : alias;
    if (ENV_OWNERS.has(node.name)) return node.name;
    return undefined;
  }
  if (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    (node.object.name === "globalThis" ||
      aliases.get(node.object.name) === "globalThis")
  ) {
    const name = propertyName(node);
    if (name !== undefined && ENV_OWNERS.has(name)) return name;
  }
  return undefined;
}

function importedName(specifier: Node): string | undefined {
  const imported = specifier.imported;
  return imported?.type === "Identifier" ? imported.name : imported?.value;
}

function patternKeyName(property: Node): string | undefined {
  const key = property.key;
  return key?.type === "Identifier"
    ? key.name
    : key?.type === "Literal"
    ? key.value
    : undefined;
}

/** Every node of the tree, parents before children, in source order. */
function* walk(node: Node): Generator<Node> {
  yield node;
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child?.type === "string") yield* walk(child);
      }
    } else if (typeof value?.type === "string") {
      yield* walk(value);
    }
  }
}

/** The lane's facts about one module; throws when it does not parse. */
export function moduleFacts(source: string): ModuleFacts {
  const { program, typeNodes, typeOnly } = parseModule(source);
  const facts: ModuleFacts = {
    imports: [],
    dynamicImports: [],
    envAccesses: [],
    dyfjKeys: [],
    packageImports: [],
    sqlWrites: [],
  };
  const line = (node: Node): number => node.loc.start.line;

  // Local bindings that stand for `Deno` or the process module: every
  // default, namespace or `default` import of `node:process`, and any
  // `const x = Deno` / `const x = process` alias.
  const aliases = new Map<string, string>();
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !PROCESS_MODULES.has(statement.source?.value)
    ) continue;
    for (const specifier of statement.specifiers ?? []) {
      if (
        specifier.type === "ImportDefaultSpecifier" ||
        specifier.type === "ImportNamespaceSpecifier" ||
        (specifier.type === "ImportSpecifier" &&
          importedName(specifier) === "default")
      ) {
        aliases.set(specifier.local.name, "process");
      }
    }
  }

  const env = (node: Node, owner: string) =>
    facts.envAccesses.push({ line: line(node), via: `${owner}.env` });
  const dyfjKey = (node: Node, value: unknown) => {
    if (typeof value === "string" && DYFJ_KEY.test(value)) {
      facts.dyfjKeys.push({ line: line(node), key: value });
    }
  };
  const sqlWrite = (node: Node, value: unknown) => {
    if (typeof value !== "string") return;
    const match = SQL_WRITE.exec(value);
    if (match) {
      facts.sqlWrites.push({
        line: line(node),
        statement: match[1]!.replace(/\s+/g, " ").trim(),
      });
    }
  };
  const packageImport = (node: Node, source: Node) => {
    const value = source?.type === "Literal" ? source.value : undefined;
    if (
      typeof value === "string" && !value.startsWith(".") &&
      !value.startsWith("/")
    ) {
      facts.packageImports.push({ line: line(node), specifier: value });
    }
  };
  const reference = (
    source: Node,
    dynamic: boolean,
    isTypeOnly: boolean,
  ) => {
    const value = source?.type === "Literal"
      ? source.value
      : source?.type === "TemplateLiteral" && source.expressions.length === 0
      ? source.quasis[0]?.value?.cooked
      : undefined;
    if (typeof value === "string") {
      // The graph's position for an import is its specifier's line.
      facts.imports.push({
        specifier: value,
        line: line(source),
        dynamic,
        typeOnly: isTypeOnly,
      });
    }
  };

  const visit = (node: Node) => {
    switch (node.type) {
      case "ImportDeclaration":
        reference(node.source, false, typeOnly.has(node));
        packageImport(node, node.source);
        if (PROCESS_MODULES.has(node.source?.value)) {
          for (const specifier of node.specifiers ?? []) {
            if (
              specifier.type === "ImportSpecifier" &&
              importedName(specifier) === "env"
            ) {
              facts.envAccesses.push({ line: line(node), via: "process.env" });
            }
          }
        }
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source) {
          reference(node.source, false, typeOnly.has(node));
          packageImport(node, node.source);
          if (PROCESS_MODULES.has(node.source.value)) {
            facts.envAccesses.push({ line: line(node), via: "process.env" });
          }
        }
        break;
      case "ImportExpression": {
        const source = node.source;
        facts.dynamicImports.push({
          specifier:
            source.type === "Literal" && typeof source.value === "string"
              ? source.value
              : null,
          line: line(node),
        });
        reference(source, true, false);
        packageImport(node, source);
        break;
      }
      case "TSImportType":
        reference(node.argument, false, true);
        packageImport(node, node.argument);
        break;
      case "MemberExpression": {
        const owner = envOwner(node.object, aliases);
        if (owner !== undefined && propertyName(node) === "env") {
          env(node, owner);
        }
        // `env.DYFJ_X`: a non-computed member name names a key.
        if (!node.computed && node.property?.type === "Identifier") {
          dyfjKey(node.property, node.property.name);
        }
        break;
      }
      case "VariableDeclarator":
        declarator(node);
        break;
      case "Property":
        // `{ DYFJ_X: value }`: an identifier key names a key.
        if (!node.computed && node.key?.type === "Identifier") {
          dyfjKey(node.key, node.key.name);
        }
        break;
      case "Literal":
        sqlWrite(node, node.value);
        dyfjKey(node, node.value);
        break;
      case "TemplateLiteral": {
        const leading = node.quasis?.[0]?.value?.cooked;
        sqlWrite(node, leading);
        if ((node.expressions ?? []).length === 0) dyfjKey(node, leading);
        break;
      }
    }
  };

  const declarator = (node: Node) => {
    const fromGlobal = node.init?.type === "Identifier" &&
      (node.init.name === "globalThis" ||
        aliases.get(node.init.name) === "globalThis");
    // `const g = globalThis` makes `g.Deno` / `g.process` owners too.
    if (fromGlobal && node.id?.type === "Identifier") {
      aliases.set(node.id.name, "globalThis");
      return;
    }
    // `const { Deno: D, process: p } = globalThis` binds owners.
    if (fromGlobal && node.id?.type === "ObjectPattern") {
      for (const property of node.id.properties ?? []) {
        const name = patternKeyName(property);
        if (
          name !== undefined && ENV_OWNERS.has(name) &&
          property.value?.type === "Identifier"
        ) {
          aliases.set(property.value.name, name);
        }
      }
      return;
    }
    const owner = envOwner(node.init, aliases);
    if (owner === undefined) return;
    if (node.id?.type === "Identifier") {
      aliases.set(node.id.name, owner);
      return;
    }
    if (node.id?.type !== "ObjectPattern") return;
    for (const property of node.id.properties ?? []) {
      if (patternKeyName(property) === "env") env(node, owner);
    }
  };

  for (const node of walk(program)) visit(node);
  for (const root of typeNodes) {
    for (const node of walk(root)) visit(node);
  }
  return facts;
}
