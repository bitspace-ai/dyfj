# DYFJ Memory MCP Server

Exposes DYFJ's Dolt-backed memory substrate to any agent that speaks MCP.

## Tools

| Tool | Description |
|------|-------------|
| `read_memory(slug)` | Fetch full content of a memory by slug |
| `list_memories(type?)` | Index of all memories, optionally filtered by type |
| `write_memory(slug, name, type, description, content)` | Upsert a memory |
| `start_session(task_description, slug?, session_name?)` | Create a session record, returns session_id |
| `update_session(session_id, phase, progress_done, progress_total, content?)` | Write phase transition |
| `list_sessions(limit?, phase?)` | List recent sessions |
| `get_session(session_id?, slug?)` | Load a prior session by id or slug |

## Running

```bash
deno run --allow-net=127.0.0.1:3306 --allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE /path/to/dyfj/prototype/mcp/server.ts
```

Transport: stdio (standard for CLI agents).

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
