# DYFJ Memory MCP Server

Exposes a conservative Dolt-backed memory projection to any agent that speaks
MCP. The standalone stdio server returns only memories classified `client_safe`
or `public`; it does not expose private or shareable memory rows.

## Tools

| Tool | Description |
|------|-------------|
| `read_memory(slug)` | Fetch full content of a client-safe or public memory by slug |
| `list_memories(type?)` | Index of client-safe and public memories, optionally filtered by type |
| `write_memory(slug, name, type, description, content)` | Upsert a memory |
| `start_session(task_description, slug?, session_name?)` | Create a session record, returns session_id |
| `update_session(session_id, status, progress_done, progress_total, content?)` | Update session state |
| `list_sessions(limit?, status?)` | List recent sessions |
| `get_session(session_id?, slug?)` | Load a prior session by id or slug |

## Running

```bash
node --permission --allow-fs-read=/path/to/dyfj --allow-net /path/to/dyfj/prototype/mcp/server.ts
```

It runs on Node 26, after `npm ci` at the repository root: Node resolves the
server's package imports from the root `node_modules`, from any working
directory. The Dolt connection comes from `DOLT_HOST`, `DOLT_PORT`,
`DOLT_USER`, `DOLT_PASSWORD` and `DOLT_DATABASE`.

`--permission` turns on Node's permission model: the server may read the
checkout and use the network, and it may not write files, start child
processes or load native addons. Node's model cannot narrow the network grant
to the Dolt endpoint or the environment to the Dolt variables, so the network
grant is broad and the server can read any environment variable it is given.
Give the agent's MCP entry only the variables the server needs. This command,
which scopes reads to the checkout, is the preferred launch.

`--allow-fs-read` must name the checkout's resolved path, with every symlink in
it followed, for example `$(cd /path/to/dyfj && pwd -P)`. Node's permission
check compares resolved paths, so a grant spelled through a symlink does not
cover the files the server loads, and the server fails to load. On macOS,
`/var` is a symlink to `/private/var`, so a checkout under a `mktemp` directory
needs the `/private/var/...` spelling that `pwd -P` prints:

```bash
DYFJ_ROOT="$(cd /path/to/dyfj && pwd -P)"
node --permission --allow-fs-read="$DYFJ_ROOT" --allow-net "$DYFJ_ROOT/prototype/mcp/server.ts"
```

The same applies to the `--allow-fs-read` argument in the agent configurations
below. The file's
shebang (`node --permission --allow-fs-read=* --allow-net`) cannot know the
checkout path, so running the file directly grants reads of every path. Node
prints an
`ExperimentalWarning` for `--allow-net` on stderr; it does not affect the
stdio protocol on stdout.

Transport: stdio (standard for CLI agents). The server uses the MCP v2 split
SDK and accepts both the modern `2026-07-28` opening and legacy `initialize`
clients from one tool factory. The Workbench-owned client probes once with a
bounded timeout, prefers the modern revision when advertised, and otherwise
falls back to a fresh legacy session process.

## Agent Configuration

Replace `/path/to/dyfj` with your actual install path and `/path/to/node` with
the output of `which node` (Node 26).

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/node",
      "args": ["--permission", "--allow-fs-read=/path/to/dyfj", "--allow-net", "/path/to/dyfj/prototype/mcp/server.ts"]
    }
  }
}
```

### Codex CLI

Same format — check Codex CLI docs for config file location.

### Gemini CLI

Same format — check Gemini CLI docs for config file location.

### Cursor / Windsurf

Add to the MCP server list in settings. Same command/args pattern.

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/node",
      "args": ["--permission", "--allow-fs-read=/path/to/dyfj", "--allow-net", "/path/to/dyfj/prototype/mcp/server.ts"]
    }
  }
}
```

## Architecture

```
Coding agent (any)
    ↓ MCP (stdio)
dyfj-memory MCP server
    ↓ store port (src/store/: the runtime's journal and readers)
DoltStore
    ↓ mysql2 (TCP → Dolt sql-server)
local Dolt sql-server (default 127.0.0.1:3306, database `dolt`)
```

Requires `dolt sql-server` running locally. See repo root README for setup.

You can inspect the running server without installing `mysql`:

```bash
dolt --host 127.0.0.1 --port 3306 --no-tls \
  --user root --password "$DOLT_PASSWORD" --use-db dolt \
  sql -q "SHOW TABLES;"
```
