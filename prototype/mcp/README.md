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
| `write_reflection(session_slug, ...)` | End-of-session synthesis |

## Running

```bash
bun run ~/.dyfj/mcp/server.ts
```

Transport: stdio (standard for CLI agents).

## Agent Configuration

Replace `~/.dyfj` with your actual install path if different. Find your bun binary with `which bun`.

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/bun",
      "args": ["run", "~/.dyfj/mcp/server.ts"]
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
      "command": "/path/to/bun",
      "args": ["run", "~/.dyfj/mcp/server.ts"]
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
~/.dyfj/data/dolt (Dolt database)
```

Requires `dolt sql-server` running locally. See repo root README for setup.
