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
  if [[ "$SOCKET_FLAG_SET" == "1" && -n "$SOCKET_FLAG_VALUE" ]]; then
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
# Reads the state parse_launcher_args recorded — never raw argv, where a
# prompt value spelled --server would masquerade as a transport switch.
uses_unix_transport() {
  if [[ "${DYFJ_UNIX:-}" == "1" ]]; then
    return 0
  fi
  [[ "$LAUNCHER_SAW_UNIX" == "1" ]] && return 0
  [[ "$LAUNCHER_SAW_SERVER" == "1" ]] && return 1
  if [[ -n "${DYFJ_SERVER_URL:-}" ]]; then
    return 1
  fi
  return 0
}

resolve_launcher_source() {
  local source="${BASH_SOURCE[0]}"
  local depth=0
  while [[ -L "$source" ]]; do
    local dir target
    depth=$((depth + 1))
    if [[ "$depth" -gt 40 ]]; then
      echo "dyfj launcher: launcher symlink chain exceeds 40 links" >&2
      return 1
    fi
    if ! dir="$(cd "$(dirname "$source")" && pwd -P)"; then
      echo "dyfj launcher: cannot resolve launcher symlink directory" >&2
      return 1
    fi
    if ! target="$(readlink "$source")" || [[ -z "$target" ]]; then
      echo "dyfj launcher: cannot read launcher symlink" >&2
      return 1
    fi
    case "$target" in
      /*) source="$target" ;;
      *) source="$dir/$target" ;;
    esac
  done
  if [[ ! -f "$source" ]]; then
    echo "dyfj launcher: resolved launcher source is not a file" >&2
    return 1
  fi
  printf '%s' "$source"
}

# BASH_SOURCE preserves the invoked symlink instead of the opened script path.
if ! LAUNCHER_SOURCE="$(resolve_launcher_source)"; then
  exit 1
fi
if ! LAUNCHER_DIR="$(cd "$(dirname "$LAUNCHER_SOURCE")" && pwd -P)"; then
  echo "dyfj launcher: cannot resolve launcher directory" >&2
  exit 1
fi

launcher_dir() {
  printf '%s' "$LAUNCHER_DIR"
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
LAUNCHER_SUBCOMMAND=""
LAUNCHER_SAW_SERVER=0
LAUNCHER_SAW_UNIX=0
LAUNCHER_SAW_HELP=0
LAUNCHER_SAW_PROMPT=0
LAUNCHER_ARGS_INVALID=0
SOCKET_FLAG_SET=0

# Flags that consume the next argument — mirrors cli.ts's VALUE_FLAGS so the
# parse below never reads a flag VALUE as launcher control input.
is_value_flag() {
  case "$1" in
    --server|--socket|--key|--mode|--model|--tier|--hint|--session|--workspace|--runner|-p|--print)
      return 0
      ;;
  esac
  return 1
}

# One positional pass over the invocation, shared by every launcher decision.
# A flag is a flag only in a CONTROL position: an argument sitting in the value
# slot of -p/--socket/--model/… is data and is preserved verbatim — so a prompt
# that happens to be the string --socket cannot re-route the probe, start a
# runtime on an unintended path, or toggle autostart. Populates CLIENT_ARGS
# (minus --no-autostart, which the client does not know), SOCKET_FLAG_VALUE,
# AUTOSTART_OPTOUT, and LAUNCHER_SUBCOMMAND (first bare positional).
parse_launcher_args() {
  CLIENT_ARGS=()
  local i=0
  local args=("$@")
  while [[ $i -lt ${#args[@]} ]]; do
    local arg="${args[$i]}"
    if [[ "$arg" == "--no-autostart" ]]; then
      AUTOSTART_OPTOUT=1
      i=$((i + 1))
      continue
    fi
    if is_value_flag "$arg"; then
      CLIENT_ARGS+=("$arg")
      if [[ "$arg" == "--server" ]]; then
        LAUNCHER_SAW_SERVER=1
      fi
      if [[ "$arg" == "-p" || "$arg" == "--print" ]]; then
        LAUNCHER_SAW_PROMPT=1
      fi
      if [[ $((i + 1)) -lt ${#args[@]} ]]; then
        if [[ "$arg" == "--socket" ]]; then
          SOCKET_FLAG_SET=1
          SOCKET_FLAG_VALUE="${args[$((i + 1))]}"
          if [[ -z "$SOCKET_FLAG_VALUE" ]]; then
            # An explicitly EMPTY socket cannot drive resolution and cannot be
            # meaningfully probed or started against: presence and value are
            # tracked separately, and empty presence declines autostart so the
            # incoherence surfaces as the client's own connect error.
            LAUNCHER_ARGS_INVALID=1
          fi
        fi
        CLIENT_ARGS+=("${args[$((i + 1))]}")
      else
        # A value flag with no value is an invocation the client will reject.
        # Autostart must not probe, spawn, or create a log on the way to that
        # usage error — the invocation is forwarded so the client's canonical
        # message is what the operator sees.
        LAUNCHER_ARGS_INVALID=1
      fi
      i=$((i + 2))
      continue
    fi
    case "$arg" in
      --unix)
        LAUNCHER_SAW_UNIX=1
        ;;
      -h|--help)
        LAUNCHER_SAW_HELP=1
        ;;
      -*) ;;
      *)
        if [[ -z "$LAUNCHER_SUBCOMMAND" ]]; then
          LAUNCHER_SUBCOMMAND="$arg"
        fi
        ;;
    esac
    CLIENT_ARGS+=("$arg")
    i=$((i + 1))
  done
}

# True when this invocation should ensure a runtime first. Position-aware:
# value-flag arguments are skipped with their values, so `dyfj -p start` (a
# PROMPT that happens to be the word start) still autostarts, while the
# subcommands do not — `start` runs the runtime itself, `status` is an honest
# reporter and must not change what it reports, help never needs a runtime.
autostart_applies() {
  [[ "${DYFJ_AUTOSTART:-1}" == "0" ]] && return 1
  [[ "$AUTOSTART_OPTOUT" == "1" ]] && return 1
  [[ "$LAUNCHER_ARGS_INVALID" == "1" ]] && return 1
  uses_unix_transport || return 1
  [[ "$LAUNCHER_SAW_HELP" == "1" ]] && return 1
  # A -p/--print prompt is a turn, so it needs a runtime even alongside a bare
  # `start`/`status` positional. Checked after help flags, which keep
  # precedence.
  [[ "$LAUNCHER_SAW_PROMPT" == "1" ]] && return 0
  case "$LAUNCHER_SUBCOMMAND" in
    start|status|help)
      return 1
      ;;
  esac
  return 0
}

# The probe and the spawned start receive the captured --socket the same way
# the client does; parse_launcher_args owns the capture.
socket_forward_args() {
  SOCKET_ARGS=()
  if [[ "$SOCKET_FLAG_SET" == "1" && -n "$SOCKET_FLAG_VALUE" ]]; then
    SOCKET_ARGS=(--socket "$SOCKET_FLAG_VALUE")
  fi
}

# The client's own parser is the validity contract: run it in --parse-check
# mode over exactly the arguments the client will receive. Unknown flags,
# invalid enum values, missing values — whatever the client would reject must
# not spawn a runtime or create a log on the way to its usage error. The
# launcher never mirrors the contract; it asks.
client_parse_check() {
  local route
  route="$(route_cli "${CLIENT_ARGS[@]}")"
  if [[ "$route" == "compiled" ]]; then
    DYFJ_PROTOTYPE_ROOT="$(prototype_root)" "$(compiled_bin)" \
      --parse-check "${CLIENT_ARGS[@]}" >/dev/null 2>&1
  else
    local proto
    proto="$(prototype_root)"
    DYFJ_PROTOTYPE_ROOT="$proto" deno run \
      --allow-env="$(cli_env_allowlist)" \
      --allow-read \
      --sloppy-imports \
      "${proto}/src/cli.ts" \
      --parse-check "${CLIENT_ARGS[@]}" >/dev/null 2>&1
  fi
}

# Log name = basename + short hash of the FULL socket path: two different
# sockets sharing a basename (every per-worktree workbench.sock) must not
# interleave into one file. No rotation here — the log grows until the
# operator clears it, stated rather than silently assumed away.
# Fails (returns 1) when HOME is unset, empty, or relative: a durable log
# carrying runtime output must never land under whatever repository the
# operator happens to be standing in, so there is no fallback directory —
# autostart declines instead.
runtime_log_path() {
  case "${HOME:-}" in
    /*) ;;
    *) return 1 ;;
  esac
  local sock base hash
  sock="$(resolve_socket_path)"
  base="$(basename "${sock%.sock}")"
  hash="$(printf '%s' "$sock" | cksum | cut -d' ' -f1)"
  printf '%s/.dyfj/log/runtime-%s-%s.log' "$HOME" "$base" "$hash"
}

# Run the client without exec, on the same route main would use. --unix is
# explicit: autostart applies only on the UDS seam, and without it an ambient
# DYFJ_SERVER_URL would let the probe answer over HTTP for a dead socket.
probe_runtime() {
  local route
  route="$(route_cli "$@")"
  if [[ "$route" == "compiled" ]]; then
    DYFJ_PROTOTYPE_ROOT="$(prototype_root)" "$(compiled_bin)"       --unix "${SOCKET_ARGS[@]}" status >/dev/null 2>&1
  else
    local sock proto
    sock="$(resolve_socket_path)"
    proto="$(prototype_root)"
    DYFJ_PROTOTYPE_ROOT="$proto" deno run       --allow-env="$(cli_env_allowlist)"       --allow-read       --allow-write       --allow-run=deno       --allow-net="127.0.0.1,localhost,unix:${sock}"       --sloppy-imports       "${proto}/src/cli.ts"       --unix "${SOCKET_ARGS[@]}" status >/dev/null 2>&1
  fi
}

ensure_runtime() {
  if probe_runtime "$@"; then
    return 0
  fi
  local sock log
  sock="$(resolve_socket_path)"
  if ! log="$(runtime_log_path)"; then
    echo "dyfj: autostart needs an absolute HOME for its log directory; set HOME or run 'dyfj start' yourself" >&2
    return 1
  fi
  # Owner-only, and treated as sensitive wholesale: the spawned runtime's
  # entire stdout/stderr lands here, and the launcher can vouch for none of
  # it — the permission bits are the floor, not a claim about the contents.
  (
    umask 077
    mkdir -p "$(dirname "$log")"
    printf -- '── dyfj autostart at %s, socket %s ──\n' \
      "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$sock" >>"$log"
  )
  chmod 700 "$(dirname "$log")" 2>/dev/null || true
  chmod 600 "$log" 2>/dev/null || true
  echo "dyfj: runtime not running at ${sock}; starting it (log: ${log})" >&2
  # Mark the background runtime to ignore a terminal SIGINT if it reaches it.
  nohup bash "$LAUNCHER_SOURCE" "${SOCKET_ARGS[@]}" start --launcher-autostarted >>"$log" 2>&1 &
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

  if uses_unix_transport && [[ "$resolved" != "$default" ]]; then
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
  parse_launcher_args "$@"
  socket_forward_args
  local route autostart
  route="$(route_cli "${CLIENT_ARGS[@]}")"
  if autostart_applies "${CLIENT_ARGS[@]}" && client_parse_check; then
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
