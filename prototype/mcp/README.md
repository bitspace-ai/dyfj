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
deno run --allow-net=127.0.0.1:3306 --allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE /path/to/dyfj/prototype/mcp/server.ts
```

Transport: stdio (standard for CLI agents). The server uses the MCP v2 split
SDK and accepts both the modern `2026-07-28` opening and legacy `initialize`
clients from one tool factory. The Workbench-owned client probes once with a
bounded timeout, prefers the modern revision when advertised, and otherwise
falls back to a fresh legacy session process.

## Agent Configuration

Replace `/path/to/dyfj` with your actual install path. Find your Deno binary with `which deno`.

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/deno",
      "args": ["run", "--allow-net=127.0.0.1:3306", "--allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE", "/path/to/dyfj/prototype/mcp/server.ts"]
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
      "command": "/path/to/deno",
      "args": ["run", "--allow-net=127.0.0.1:3306", "--allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE", "/path/to/dyfj/prototype/mcp/server.ts"]
    }
  }
}
```

## Architecture

```
Coding agent (any)
    ↓ MCP (stdio)
dyfj-memory MCP server
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
