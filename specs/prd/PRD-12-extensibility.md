# PRD-12 — Provider, tool, and extension extensibility

**Phase:** 1. **Priority driver:** you can't add providers or tools cheaply.
**Work orders:** WO-14, WO-15, WO-20.

## Problem

Adding a provider today means editing a 3,873-line file with an internal switch
on `model.api`, then adding tests to a 6,593-line test file.

Tools are no better:

- **Three tool shapes.** Tools come in three shapes, and some tool builders live
  in `commands.ts`, away from their executors.
- **Three registry assemblies.** The tool registry is assembled in three places.

Operator-specific features (ideas, packets, friction, Linear) are threaded
through the CLI, the server handlers, and the sessions module.

## Goals

1. **Provider adapters.** Add a `ProviderAdapter` interface with one directory
   per API family and a provider conformance kit (`01-architecture.md` §5.2,
   `03-testing.md` §5).
2. **One tool shape.** Use one tool shape with the builder colocated with its
   executor, one `buildToolCatalog`, and a tool conformance kit (§5.4).
3. **One MCP transport module.** A single MCP transport/client factory (§5.5).
4. **Extension interface.** Add the Extension interface. Ideas, packets,
   friction, and Linear move behind it and stay enabled by default (§6).
5. **Recipes.** Write `specs/recipes/add-provider.md` and
   `specs/recipes/add-tool.md`, each validated by actually following it (below).

## Non-goals

- New providers or tools. The recipe validation adds a test-only adapter/tool,
  not a product one.
- Dynamic plugin loading.

## Requirements

- **R1. Provider validation.** Following `add-provider.md`, an agent adds a
  test-only adapter for a synthetic API family that passes the conformance kit.
  It touches only:
  - the new adapter directory;
  - one registry line;
  - test fixtures. The adapter is kept under `testing/` as a living example.
- **R2. Tool validation.** Following `add-tool.md`, a test-only tool is added.
  It touches:
  - one module;
  - one catalog line. The tool conformance kit covers it automatically.
- **R3. Existing providers pass the kit.** The OpenAI-compatible, Anthropic, and
  Gemini adapters pass the kit with recorded fixtures. The existing
  request-building and stream-parsing tests are folded into those fixtures.
- **R4. Extensions stay out of core.** No code outside `extensions/`, `server/`,
  and `cli/` imports an extension.
- **R5. Surfaces unchanged.** The golden suite is unchanged: same method names,
  REPL commands, and tool names.

## Success metrics

| Change                    | Before                                           | After                    |
| ------------------------- | ------------------------------------------------ | ------------------------ |
| Add an API-family adapter | edits scattered across `provider.ts` (3,873 LOC) | one directory + one line |
| Add a tool                | 2–3 files                                        | 1 file + 1 line          |

Registry assembly sites go from 3 to 1.

## Risks

- **Text tool-call extraction** (~500 lines of markup parsing) is shared by
  several local models and is subtle. Mitigation: move it verbatim first.
  Refactor it only with fixture coverage from real captured model outputs, which
  already exist in `provider.test.ts`.
- **Extension-boundary coupling.** Friction currently builds its own command
  registry inside the server. The extension must receive the Linear command
  through `ExtensionDeps`, not rebuild it.
