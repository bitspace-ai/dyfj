# Solo Operator Context Kit

This example shows a small context kit with three layers:

```text
source -> projection -> harness adapter
```

The scenario is fictional. Alex runs ExampleOps and keeps a small workbench for
project notes, automation experiments, and durable decisions.

## Layout

- `source/` is the canonical context. Edit these files when the operator context
  changes.
- `projections/assistant-context.md` is a generated consumer-shaped subset.
- `adapters/` contains harness-specific instruction files that point at the
  projection.
- `render.mjs` assembles the projection from the source files with no external
  dependencies.

## Boundary Rules

The source layer owns durable facts. A projection is a rendered view for a
consumer and can be regenerated. An adapter is glue for one harness shape.

If a projection is stale, fix the source and run:

```sh
node examples/context-kits/solo-operator/render.mjs
```

Local project instructions override this context kit for execution details. The
context kit can shape collaboration, but it does not replace repository
instructions, runtime policy, issue state, or permissions.

## Try It

From the repository root:

```sh
node examples/context-kits/solo-operator/render.mjs
node --test examples/context-kits/solo-operator/render.test.mjs
```
