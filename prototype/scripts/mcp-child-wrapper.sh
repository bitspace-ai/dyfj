#!/bin/sh

printf '%s\n' "$$" >> "$DYFJ_MCP_PID_LOG"
exec "$DYFJ_REAL_DENO" "$@"
