#!/usr/bin/env bash
# dyfj CLI launcher: fast compiled binary on the default UDS path; deno run with a
# dynamically resolved unix: net grant when DYFJ_SOCKET or XDG_RUNTIME_DIR shifts
# the socket away from ~/.dyfj/run/workbench.sock (Deno 2.9 exact-match grants).
set -euo pipefail

# Highest precedence: an explicit --socket argument, captured once by
# socket_override_args. Routing, Deno net grants, log naming, the probe, the
# spawned start, and the final client must all see the SAME socket — a flag
# that reached the client but not the probe's net grant would leave the
# launcher starting a runtime it can never see answer.
SOCKET_FLAG_VALUE=""

resolve_socket_path() {
  if [[ -n "$SOCKET_FLAG_VALUE" ]]; then
    printf '%s' "$SOCKET_FLAG_VALUE"
    return
  fi
  if [[ -n "${DYFJ_SOCKET:-}" ]]; then
    printf '%s' "$DYFJ_SOCKET"
    return
  fi
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    printf '%s' "$XDG_RUNTIME_DIR/dyfj/workbench.sock"
    return
  fi
  printf '%s' "${HOME:-.}/.dyfj/run/workbench.sock"
}

default_socket_path() {
  printf '%s' "${HOME:-.}/.dyfj/run/workbench.sock"
}

# Mirror resolveConfig: --unix / DYFJ_UNIX=1 win over an explicit HTTP server.
uses_unix_transport() {
  if [[ "${DYFJ_UNIX:-}" == "1" ]]; then
    return 0
  fi
  local arg
  local saw_server=0
  for arg in "$@"; do
    case "$arg" in
      --unix)
        return 0
        ;;
      --server|--server=*)
        saw_server=1
        ;;
    esac
  done
  if [[ -n "${DYFJ_SERVER_URL:-}" ]]; then
    return 1
  fi
  [[ "$saw_server" -eq 0 ]]
}

launcher_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

# ── Autostart ────────────────────────────────────────────────────────────────
#
# A bare `dyfj` (and any other invocation that needs a live runtime over the
# UDS seam) probes the socket first and, when nothing answers, starts the
# runtime detached — logs to ~/.dyfj/log/ — then waits for the socket before
# handing over to the client. One command, one terminal. `dyfj start` remains
# the explicit foreground supervisor and is never auto-invoked FOR a `start`.
#
# The probe is the client's own `status` (exit 0 iff the runtime answered), so
# a stale socket file left by a crash routes into the start path, where the
# server's bind safety clears it. Two launchers racing both spawn a start; the
# server refuses the second bind while the first answers, the loser exits into
# the log, and both clients converge on the winner. Opt out per-call with
# --no-autostart (consumed here, never passed to the client) or standing with
# DYFJ_AUTOSTART=0.

AUTOSTART_OPTOUT=0

# Populate CLIENT_ARGS with "$@" minus --no-autostart.
strip_autostart_flag() {
  CLIENT_ARGS=()
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "--no-autostart" ]]; then
      AUTOSTART_OPTOUT=1
    else
      CLIENT_ARGS+=("$arg")
    fi
  done
}

# Flags that consume the next argument — mirrors cli.ts's VALUE_FLAGS so the
# classification below never reads a flag VALUE as a subcommand.
is_value_flag() {
  case "$1" in
    --server|--socket|--key|--mode|--model|--tier|--hint|--session|--workspace|-p|--print)
      return 0
      ;;
  esac
  return 1
}

# True when this invocation should ensure a runtime first. Position-aware:
# value-flag arguments are skipped with their values, so `dyfj -p start` (a
# PROMPT that happens to be the word start) still autostarts, while the
# subcommands do not — `start` runs the runtime itself, `status` is an honest
# reporter and must not change what it reports, help never needs a runtime.
autostart_applies() {
  [[ "${DYFJ_AUTOSTART:-1}" == "0" ]] && return 1
  [[ "$AUTOSTART_OPTOUT" == "1" ]] && return 1
  uses_unix_transport "$@" || return 1
  local i=0
  local args=("$@")
  while [[ $i -lt ${#args[@]} ]]; do
    local arg="${args[$i]}"
    if is_value_flag "$arg"; then
      i=$((i + 2))
      continue
    fi
    case "$arg" in
      start|status|help|-h|--help)
        return 1
        ;;
    esac
    i=$((i + 1))
  done
  return 0
}

# An explicit --socket must reach the probe and the spawned start the same way
# it reaches the client; environment resolution already flows on its own.
socket_override_args() {
  SOCKET_ARGS=()
  local i=0
  local args=("$@")
  while [[ $i -lt ${#args[@]} ]]; do
    if [[ "${args[$i]}" == "--socket" && $((i + 1)) -lt ${#args[@]} ]]; then
      SOCKET_FLAG_VALUE="${args[$((i + 1))]}"
      SOCKET_ARGS=(--socket "$SOCKET_FLAG_VALUE")
      return 0
    fi
    i=$((i + 1))
  done
  return 0
}

# Log name = basename + short hash of the FULL socket path: two different
# sockets sharing a basename (every per-worktree workbench.sock) must not
# interleave into one file. No rotation here — the log grows until the
# operator clears it, stated rather than silently assumed away.
runtime_log_path() {
  local sock base hash
  sock="$(resolve_socket_path)"
  base="$(basename "${sock%.sock}")"
  hash="$(printf '%s' "$sock" | cksum | cut -d' ' -f1)"
  printf '%s/.dyfj/log/runtime-%s-%s.log' "${HOME:-.}" "$base" "$hash"
}

# Run the client without exec, on the same route main would use.
probe_runtime() {
  local route
  route="$(route_cli "$@")"
  if [[ "$route" == "compiled" ]]; then
    DYFJ_PROTOTYPE_ROOT="$(prototype_root)" "$(compiled_bin)"       "${SOCKET_ARGS[@]}" status >/dev/null 2>&1
  else
    local sock proto
    sock="$(resolve_socket_path)"
    proto="$(prototype_root)"
    DYFJ_PROTOTYPE_ROOT="$proto" deno run       --allow-env="$(cli_env_allowlist)"       --allow-read       --allow-write       --allow-run=deno       --allow-net="127.0.0.1,localhost,unix:${sock}"       --sloppy-imports       "${proto}/src/cli.ts"       "${SOCKET_ARGS[@]}" status >/dev/null 2>&1
  fi
}

ensure_runtime() {
  if probe_runtime "$@"; then
    return 0
  fi
  local sock log
  sock="$(resolve_socket_path)"
  log="$(runtime_log_path)"
  # Owner-only: the runtime writes session/model/cost metadata and secret
  # POINTER names (never values) to its stderr, and all of it lands here.
  (
    umask 077
    mkdir -p "$(dirname "$log")"
    printf -- '── dyfj autostart at %s, socket %s ──\n' \
      "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$sock" >>"$log"
  )
  chmod 700 "$(dirname "$log")" 2>/dev/null || true
  chmod 600 "$log" 2>/dev/null || true
  echo "dyfj: runtime not running at ${sock}; starting it (log: ${log})" >&2
  nohup bash "$(launcher_dir)/$(basename "${BASH_SOURCE[0]}")"     "${SOCKET_ARGS[@]}" start >>"$log" 2>&1 &
  disown
  local i
  for i in $(seq 1 50); do
    if probe_runtime "$@"; then
      echo "dyfj: runtime ready" >&2
      return 0
    fi
    sleep 0.3
  done
  # No seconds figure in the message: the loop is 50 probes with 0.3s gaps,
  # but each probe has its own startup cost, so wall time is not a constant.
  echo "dyfj: runtime is not answering — check ${log} or run 'dyfj start' in the foreground" >&2
  return 1
}

prototype_root() {
  printf '%s' "$(cd "$(launcher_dir)/.." && pwd)"
}

compiled_bin() {
  local dir
  dir="$(launcher_dir)"
  if [[ "$(basename "$dir")" == "dist" ]]; then
    printf '%s/dyfj-bin' "$dir"
  else
    printf '%s/dist/dyfj-bin' "$(prototype_root)"
  fi
}

compiled_is_fresh() {
  local compiled proto source launcher
  compiled="$(compiled_bin)"
  proto="$(prototype_root)"
  source="$proto/src/cli.ts"
  launcher="$proto/scripts/dyfj-launcher.sh"
  [[ -x "$compiled" ]] || return 1
  if [[ -e "$source" && ! "$compiled" -nt "$source" ]]; then
    return 1
  fi
  if [[ -e "$launcher" && ! "$compiled" -nt "$launcher" ]]; then
    return 1
  fi
  return 0
}

# DYFJ_MEMORY_MCP_URL is engine config, but `dyfj start` must read it to build
# the child's --allow-net grant (ambient env overrides --env-file in the child).
# DYFJ_ROOT is likewise engine config the launcher reads only to locate
# ~/.dyfj/config.toml and derive the child's --allow-run resolver-binary grant.
cli_env_allowlist() {
  printf '%s' 'DYFJ_SERVER_URL,DYFJ_SOCKET,DYFJ_WORKSPACE,DYFJ_PROTOTYPE_ROOT,DYFJ_ROOT,HOME,XDG_RUNTIME_DIR,DYFJ_WORKBENCH_API_KEY,DYFJ_WORKBENCH_MODEL,DYFJ_WORKBENCH_HINT,DYFJ_WORKBENCH_TIER,DYFJ_UNIX,DYFJ_MEMORY_MCP_URL,NO_COLOR'
}

route_cli() {
  local resolved default
  resolved="$(resolve_socket_path)"
  default="$(default_socket_path)"

  if uses_unix_transport "$@" && [[ "$resolved" != "$default" ]]; then
    printf 'deno'
    return
  fi
  if compiled_is_fresh; then
    printf 'compiled'
    return
  fi
  printf 'deno'
}

run_deno_cli() {
  local sock proto
  sock="$(resolve_socket_path)"
  proto="$(prototype_root)"
  DYFJ_PROTOTYPE_ROOT="$proto" exec deno run \
    --allow-env="$(cli_env_allowlist)" \
    --allow-read \
    --allow-write \
    --allow-run=deno \
    --allow-net="127.0.0.1,localhost,unix:${sock}" \
    --sloppy-imports \
    "${proto}/src/cli.ts" \
    "$@"
}

main() {
  strip_autostart_flag "$@"
  socket_override_args "${CLIENT_ARGS[@]}"
  local route autostart
  route="$(route_cli "${CLIENT_ARGS[@]}")"
  if autostart_applies "${CLIENT_ARGS[@]}"; then
    autostart="yes"
  else
    autostart="no"
  fi

  if [[ "${DYFJ_LAUNCHER_DRY_RUN:-}" == "1" ]]; then
    printf 'route=%s autostart=%s sock=%s\n'       "$route" "$autostart" "$(resolve_socket_path)"
    exit 0
  fi

  if [[ "$autostart" == "yes" ]]; then
    ensure_runtime "${CLIENT_ARGS[@]}" || exit 1
  fi

  case "$route" in
    compiled)
      DYFJ_PROTOTYPE_ROOT="$(prototype_root)" exec "$(compiled_bin)" "${CLIENT_ARGS[@]}"
      ;;
    deno)
      run_deno_cli "${CLIENT_ARGS[@]}"
      ;;
    *)
      echo "dyfj launcher: unknown route '$route'" >&2
      exit 1
      ;;
  esac
}

main "$@"
