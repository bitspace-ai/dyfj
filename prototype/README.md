# DYFJ Prototype (TypeScript on Deno)

This is the TypeScript prototype layer of DYFJ.

This layer contains working prototype code for Workbench, memory, command routing, provider routing, budget tracking, session persistence, MCP, and tests. Stabilized components can move into `../core/` when the Rust boundary is worth the extra compile-time structure.

If you want to understand DYFJ's stance on why prototype-and-substrate coexist in the same repo, read the project README at the repo root, especially the Layer 0 stance on Rust as a moving boundary.

## Run it

You'll need [Deno](https://deno.com) 2.7+.

```sh
deno install
deno task workbench
```

For the barebones operator loop:

```sh
deno task workbench shell
```

Inside the shell, enter a prompt to run one Workbench turn. `:session` prints the last session/trace pointer, and `:quit`, `:q`, or `exit` quits cleanly.

The prototype reads Dolt connection settings from environment variables. For the default local server:

```sh
export DOLT_HOST=127.0.0.1
export DOLT_PORT=3306
export DOLT_USER=root
export DOLT_PASSWORD=<your-local-dolt-password>
export DOLT_DATABASE=dolt
```

Useful checks:

```sh
deno task test
deno task verify-workbench-events
(cd .. && deno task test:schema)
(cd .. && deno task validate-schema)
```

## Layout

- `src/` — Workbench entrypoint and shell, command registry, provider path, memory, budget, session persistence, event verification, MCP client, utilities, tests
- `mcp/` — MCP server (`server.ts`)
- `examples/` — runnable Deno demos

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). The TypeScript versions can stay or be retired on a case-by-case basis. There's no global port plan — Rust earns its way in component by component, and TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness.
