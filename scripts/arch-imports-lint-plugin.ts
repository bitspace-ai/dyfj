/**
 * Deno lint plugin for the arch.imports lane: reports every dynamic `import()`
 * expression from the parsed AST, so the lane sees each dynamic import even
 * when the same file also imports that module statically (`deno info` merges
 * the two into one static dependency). Loaded only through
 * `arch-imports-lint.json`; it is not part of the repository's lint setup.
 */

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
  },
};

export default plugin;
