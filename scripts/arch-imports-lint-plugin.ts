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
 *   `["env"]`), destructuring `env` out of `Deno` or `process`, and importing
 *   `env` from `node:process`.
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

/** `Deno` / `process`, bare or as `globalThis.Deno` / `globalThis.process`. */
function envOwner(node: Node): string | undefined {
  if (node?.type === "Identifier" && ENV_OWNERS.has(node.name)) {
    return node.name;
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
        return {
          MemberExpression(node: Node) {
            const owner = envOwner(node.object);
            if (owner !== undefined && propertyName(node) === "env") {
              context.report({ node, message: `${owner}.env` });
            }
          },
          VariableDeclarator(node: Node) {
            const owner = envOwner(node.init);
            if (owner === undefined || node.id?.type !== "ObjectPattern") {
              return;
            }
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
          ImportDeclaration(node: Node) {
            if (
              node.source?.value !== "node:process" &&
              node.source?.value !== "process"
            ) return;
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
