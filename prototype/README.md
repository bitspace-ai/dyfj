# DYFJ Prototype (TypeScript on Bun)

This is the TypeScript prototype layer of DYFJ. It's where I work out the shape of components before any of them earn their way down to the Rust core.

The code here is real and works — router, memory, budget, MCP server, tests. It uses pi-ai for model abstraction and Dolt for persistence. It's not throwaway scaffolding. But it's also not the substrate. The substrate lives in `../core/` and grows downward as components stabilize.

If you want to understand DYFJ's stance on why prototype-and-substrate coexist in the same repo, read the project README at the repo root, especially the Layer 0 stance on Rust as a moving boundary.

## Run it

You'll need [Bun](https://bun.sh).

```sh
bun install
bun run start
```

## Layout

- `src/` — router, memory, budget, MCP client, utilities, tests
- `mcp/` — MCP server (`server.ts`)
- `examples/` — runnable demos (e.g. `router-tour.ts`)
- `.pi/extensions/` — pi-mono extensions registered into the harness when used from this directory

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). The TypeScript versions can stay or be retired on a case-by-case basis. There's no global port plan — Rust earns its way in component by component, and TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness.
