/**
 * Lint plugin for the `erasable.syntax` lane. Loaded only through
 * `erasable-syntax-lint.json`; it is not part of the repository's lint setup.
 *
 * - `parameter-property` reports every constructor parameter that carries an
 *   accessibility, `readonly` or `override` modifier. Node runs TypeScript by
 *   stripping types without transforming them, and a parameter property is
 *   the one construct here that stripping cannot erase.
 */

// deno-lint-ignore no-explicit-any
type Node = any;

export default {
  name: "erasable-syntax",
  rules: {
    "parameter-property": {
      // deno-lint-ignore no-explicit-any
      create(context: any) {
        return {
          TSParameterProperty(node: Node) {
            const name = node.parameter?.type === "Identifier"
              ? node.parameter.name
              : node.parameter?.left?.name ?? "?";
            context.report({ node, message: name });
          },
        };
      },
    },
  },
};
