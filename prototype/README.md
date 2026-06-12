# DYFJ Prototype (TypeScript on Deno)

This is the TypeScript prototype layer of DYFJ.

This layer contains working prototype code for Workbench CLI/shell, local HTTP, shared runtime execution, memory, command routing, provider routing, budget tracking, session persistence, MCP, and tests. Stabilized components can move into `../core/` when the Rust boundary is worth the extra compile-time structure.

If you want to understand DYFJ's stance on why prototype-and-substrate coexist in the same repo, read the project README at the repo root, especially the Layer 0 stance on Rust as a moving boundary.

## Run it

You'll need [Deno](https://deno.com) 2.7+.

```sh
deno install
deno task workbench
```

The Apple silicon local default expects an OpenAI-compatible MLX-LM Server:

```sh
mlx_lm.server \
  --model mlx-community/Qwen3.5-4B-8bit \
  --host 127.0.0.1 \
  --port 18080
```

Workbench uses `http://127.0.0.1:18080/v1` for that MLX endpoint. Ollama remains a supported local fallback; pass `--model laguna-xs.2` or set `DYFJ_WORKBENCH_MODEL=laguna-xs.2` to select the fallback explicitly.

Hosted inference is explicit escalation: select a hosted model by slug (for example `--model claude-haiku-4-5`), pass the budget preflight and consent prompt, and the turn is receipted with cost and prompt-cache telemetry. The Anthropic provider reads `ANTHROPIC_API_KEY` from the process environment and fails closed without it - project the key at process start (for example `op run`), never an ambient export.

For the barebones operator loop:

```sh
deno task workbench shell
```

Inside the shell, enter a prompt to run one Workbench turn. `:session` prints the last session/trace pointer, and `:quit`, `:q`, or `exit` quits cleanly.

For the local HTTP veneer:

```sh
deno task workbench-http
```

The HTTP task listens on `http://127.0.0.1:8787/` by default. `GET /` returns a minimal HTML surface; `POST /api/turn` accepts JSON and calls the same single-turn runtime used by the CLI veneer; `GET /api/models` returns the model registry for pickers.

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

For Workbench failures that look like "the model never responds", check the selected local provider directly before debugging DYFJ. For MLX-LM Server:

```sh
curl -sS http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mlx-community/Qwen3.5-4B-8bit","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

For Ollama:

```sh
curl -sS http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"gemma4:e2b","prompt":"pong","stream":false,"options":{"num_predict":1}}'
```

The response must include generated text. Health/list endpoints such as Ollama `/api/version`, `/api/tags`, and `/api/ps` do not prove the model runner can load.

## Experimental tracers

The Beads tracer is a small prototype demo for parent/child task decomposition, worker completion, gated recombination, and cleanup:

```sh
BEADS_DIR=/path/to/.beads deno task beads-tracer
```

It creates and deletes demo beads in the target Beads workspace.

## Layout

- `src/` — Workbench entrypoint, shell, local HTTP veneer, shared runtime boundary, command registry, provider path, memory, budget, session persistence, event verification, MCP client, utilities, tests
- `mcp/` — MCP server (`server.ts`)
- `examples/` — runnable Deno demos and tracers

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). The TypeScript versions can stay or be retired on a case-by-case basis. There's no global port plan — Rust earns its way in component by component, and TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness.
