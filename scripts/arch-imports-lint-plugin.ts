/**
 * Deno lint plugin for the arch.imports lane. Loaded only through
 * `arch-imports-lint.json`; it is not part of the repository's lint setup.
 *
 * - `dynamic-import` reports every dynamic `import()` expression from the
 *   parsed AST, so the lane sees each dynamic import even when the same file
 *   also imports that module statically (`deno info` merges the two into one
 *   static dependency).
 * - `env-access` reports every direct read of the process environment:
 *   `Deno.env`, `process.env` (including `globalThis.` forms and computed
 *   `["env"]`), `.env` on any default, namespace or `default` import of
 *   `node:process` and on a `const` alias of `Deno` or `process`, destructuring
 *   `env` out of any of those, importing `env` from `node:process`, and
 *   re-exporting from `node:process`.
 * - `dyfj-key` reports every string literal that is exactly a `DYFJ_*`
 *   environment key, so the lane can require each one to be declared.
 */

const ENV_OWNERS = new Set(["Deno", "process"]);
const DYFJ_KEY = /^DYFJ_[A-Z0-9_]+$/;

// deno-lint-ignore no-explicit-any
type Node = any;

function propertyName(node: Node): string | undefined {
  if (node.computed) {
    return node.property?.type === "Literal" &&
        typeof node.property.value === "string"
      ? node.property.value
      : undefined;
  }
  return node.property?.type === "Identifier" ? node.property.name : undefined;
}

const PROCESS_MODULES = new Set(["node:process", "process"]);

/**
 * `Deno` / `process`, bare, as `globalThis.Deno` / `globalThis.process`, or
 * through a local alias (`aliases`: binding name → owner).
 */
function envOwner(
  node: Node,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  if (node?.type === "Identifier") {
    if (aliases.has(node.name)) return aliases.get(node.name);
    if (ENV_OWNERS.has(node.name)) return node.name;
    return undefined;
  }
  if (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" && node.object.name === "globalThis"
  ) {
    const name = propertyName(node);
    if (name !== undefined && ENV_OWNERS.has(name)) return name;
  }
  return undefined;
}

const plugin: Deno.lint.Plugin = {
  name: "arch-imports",
  rules: {
    "dynamic-import": {
      create(context) {
        return {
          ImportExpression(node) {
            const source = node.source;
            context.report({
              node,
              message: source.type === "Literal" &&
                  typeof source.value === "string"
                ? `literal:${source.value}`
                : "non-literal",
            });
          },
        };
      },
    },
    "env-access": {
      create(context) {
        // Local bindings that stand for `Deno` or the process module: every
        // default, namespace or `default` import of `node:process`, and any
        // `const x = Deno` / `const x = process` alias.
        const aliases = new Map<string, string>();
        return {
          Program(node: Node) {
            for (const statement of node.body ?? []) {
              if (
                statement.type !== "ImportDeclaration" ||
                !PROCESS_MODULES.has(statement.source?.value)
              ) continue;
              for (const specifier of statement.specifiers ?? []) {
                const imported = specifier.imported;
                const importedName = imported?.type === "Identifier"
                  ? imported.name
                  : imported?.value;
                if (
                  specifier.type === "ImportDefaultSpecifier" ||
                  specifier.type === "ImportNamespaceSpecifier" ||
                  (specifier.type === "ImportSpecifier" &&
                    importedName === "default")
                ) {
                  aliases.set(specifier.local.name, "process");
                }
              }
            }
          },
          MemberExpression(node: Node) {
            const owner = envOwner(node.object, aliases);
            if (owner !== undefined && propertyName(node) === "env") {
              context.report({ node, message: `${owner}.env` });
            }
          },
          VariableDeclarator(node: Node) {
            const owner = envOwner(node.init, aliases);
            if (owner === undefined) return;
            if (node.id?.type === "Identifier") {
              aliases.set(node.id.name, owner);
              return;
            }
            if (node.id?.type !== "ObjectPattern") return;
            for (const property of node.id.properties ?? []) {
              const key = property.key;
              const name = key?.type === "Identifier"
                ? key.name
                : key?.type === "Literal"
                ? key.value
                : undefined;
              if (name === "env") {
                context.report({ node, message: `${owner}.env` });
              }
            }
          },
          ExportNamedDeclaration(node: Node) {
            if (PROCESS_MODULES.has(node.source?.value)) {
              context.report({ node, message: "process.env" });
            }
          },
          ExportAllDeclaration(node: Node) {
            if (PROCESS_MODULES.has(node.source?.value)) {
              context.report({ node, message: "process.env" });
            }
          },
          ImportDeclaration(node: Node) {
            if (!PROCESS_MODULES.has(node.source?.value)) return;
            for (const specifier of node.specifiers ?? []) {
              const imported = specifier.imported;
              const name = imported?.type === "Identifier"
                ? imported.name
                : imported?.value;
              if (specifier.type === "ImportSpecifier" && name === "env") {
                context.report({ node, message: "process.env" });
              }
            }
          },
        };
      },
    },
    "dyfj-key": {
      create(context) {
        const report = (node: Node, value: unknown) => {
          if (typeof value === "string" && DYFJ_KEY.test(value)) {
            context.report({ node, message: value });
          }
        };
        return {
          Literal(node: Node) {
            report(node, node.value);
          },
          TemplateLiteral(node: Node) {
            if ((node.expressions ?? []).length === 0) {
              const quasi = node.quasis?.[0];
              report(node, quasi?.cooked ?? quasi?.value?.cooked);
            }
          },
        };
      },
    },
  },
};

export default plugin;
