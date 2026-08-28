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
LAUNCHER_SAW_HELP=0
LAUNCHER_SAW_PROMPT=0
LAUNCHER_ARGS_INVALID=0
SOCKET_FLAG_SET=0

# Flags that consume the next argument — mirrors cli.ts's VALUE_FLAGS so the
# parse below never reads a flag VALUE as launcher control input.
is_value_flag() {
  case "$1" in
    --socket|--mode|--model|--tier|--hint|--session|--workspace|--runner|-p|--print)
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
  [[ "$LAUNCHER_SAW_HELP" == "1" ]] && return 1
  # A -p/--print prompt is a turn, so it needs a runtime even alongside a bare
  # `start`/`status` positional. Checked after help flags, which keep
  # precedence.
  [[ "$LAUNCHER_SAW_PROMPT" == "1" ]] && return 0
  case "$LAUNCHER_SUBCOMMAND" in
    start|status|stop|help)
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
  route="$(route_cli ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"})"
  if [[ "$route" == "compiled" ]]; then
    DYFJ_PROTOTYPE_ROOT="$(prototype_root)" "$(compiled_bin)" \
      --parse-check ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"} >/dev/null 2>&1
  else
    local proto
    proto="$(prototype_root)"
    DYFJ_PROTOTYPE_ROOT="$proto" deno run \
      --allow-env="$(cli_env_allowlist)" \
      --allow-read \
      --sloppy-imports \
      "${proto}/src/cli.ts" \
      --parse-check ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"} >/dev/null 2>&1
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

# Start lock name = basename + 16-hex sha256 (or cksum fallback) of the FULL socket path:
# mirrors runtime_log_path, keyed by socket. Uses exclusive file creation (noclobber)
# to rate-limit and suppress duplicate background launcher autostart processes.
# Fails when HOME is unset, empty, or relative.
runtime_start_lock_path() {
  case "${HOME:-}" in
    /*) ;;
    *) return 1 ;;
  esac
  local sock base hash
  sock="$(resolve_socket_path)"
  base="$(basename "${sock%.sock}")"
  hash="$(printf '%s' "$sock" | shasum -a 256 2>/dev/null | cut -c1-16)"
  if [[ -z "$hash" ]]; then
    hash="$(printf '%s' "$sock" | cksum | cut -d' ' -f1)"
  fi
  printf '%s/.dyfj/run/start-%s-%s.lock' "$HOME" "$base" "$hash"
}

# Run the client without exec, on the same route main would use. The probe is
# always the UDS `status` command — JSON-RPC over the socket is the only seam.
probe_runtime() {
  local route
  route="$(route_cli "$@")"
  if [[ "$route" == "compiled" ]]; then
    DYFJ_PROTOTYPE_ROOT="$(prototype_root)" "$(compiled_bin)" \
      ${SOCKET_ARGS[@]+"${SOCKET_ARGS[@]}"} status >/dev/null 2>&1
  else
    local sock proto
    sock="$(resolve_socket_path)"
    proto="$(prototype_root)"
    DYFJ_PROTOTYPE_ROOT="$proto" deno run \
      --allow-env="$(cli_env_allowlist)" \
      --allow-read \
      --allow-write \
      --allow-run=deno \
      --allow-net="127.0.0.1,localhost,unix:${sock}" \
      --sloppy-imports \
      "${proto}/src/cli.ts" \
      ${SOCKET_ARGS[@]+"${SOCKET_ARGS[@]}"} status >/dev/null 2>&1
  fi
}

get_file_mtime() {
  local f="$1" out
  out="$(stat -c '%Y' "$f" 2>/dev/null || true)"
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return
  fi
  out="$(stat -f '%m' "$f" 2>/dev/null || true)"
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return
  fi
  echo 0
}

inspect_start_lock_in_flight() {
  local lock_file="$1" now="$2" ttl="$3"
  local info_data lock_ts lock_pid lock_age
  info_data="$(head -c 128 "$lock_file" 2>/dev/null || true)"
  if [[ -z "$info_data" ]]; then
    local mtime grace=5
    if [[ "$ttl" =~ ^[0-9]+$ ]] && [[ "$ttl" -lt "$grace" ]]; then
      grace="$ttl"
    fi
    mtime="$(get_file_mtime "$lock_file")"
    if [[ "$mtime" =~ ^[0-9]+$ ]] && [[ "$now" =~ ^[0-9]+$ ]] && [[ "$now" -ge "$mtime" ]] && [[ "$((now - mtime))" -lt "$grace" ]]; then
      return 0
    fi
    return 1
  fi
  read -r lock_ts lock_pid <<<"$info_data"
  if [[ "$lock_ts" =~ ^[0-9]+$ ]] && [[ "$now" =~ ^[0-9]+$ ]]; then
    if [[ "$now" -ge "$lock_ts" ]]; then
      lock_age=$((now - lock_ts))
    elif [[ "$((lock_ts - now))" -le "$ttl" ]]; then
      lock_age=0
    else
      lock_age=$((ttl + 1))
    fi
    if [[ "$lock_age" -lt "$ttl" ]]; then
      if [[ "$lock_pid" =~ ^[1-9][0-9]*$ ]]; then
        if kill -0 "$lock_pid" 2>/dev/null; then
          return 0
        fi
      else
        return 0
      fi
    fi
  fi
  return 1
}

ensure_runtime() {
  local start_lock
  start_lock="$(runtime_start_lock_path 2>/dev/null || true)"
  if probe_runtime "$@"; then
    [[ -n "$start_lock" ]] && rm -f "$start_lock" 2>/dev/null || true
    return 0
  fi
  prepare_node_path
  prepare_toolchain_path || return 1
  prepare_rustup_home || return 1
  local sock log
  sock="$(resolve_socket_path)"
  if ! log="$(runtime_log_path)"; then
    echo "dyfj: autostart needs an absolute HOME for its log directory; set HOME or run 'dyfj start' yourself" >&2
    return 1
  fi
  if ! start_lock="$(runtime_start_lock_path)"; then
    echo "dyfj: autostart needs an absolute HOME for its lock directory; set HOME or run 'dyfj start' yourself" >&2
    return 1
  fi

  local lock_dir
  lock_dir="$(dirname "$start_lock")"
  (
    umask 077
    mkdir -p "$lock_dir"
  ) || {
    echo "dyfj: autostart cannot create lock directory ${lock_dir}" >&2
    return 1
  }
  chmod 700 "$lock_dir" 2>/dev/null || true

  local ttl=30
  if [[ "${DYFJ_START_LOCK_TTL_SEC:-}" =~ ^[0-9]{1,6}$ ]]; then
    ttl=$((10#${DYFJ_START_LOCK_TTL_SEC}))
    if [[ "$ttl" -le 0 ]]; then
      ttl=30
    fi
  fi

  local now is_in_flight=0 acquired_lock=0
  now="$(date +%s 2>/dev/null || echo 0)"

  # Attempt exclusive lock acquisition via noclobber file creation
  if ( umask 077 && set -C && printf '%s %s\n' "$now" "$$" > "$start_lock" ) 2>/dev/null; then
    acquired_lock=1
  elif [[ ! -f "$start_lock" ]]; then
    echo "dyfj: autostart cannot create lock file ${start_lock}" >&2
    return 1
  else
    if inspect_start_lock_in_flight "$start_lock" "$now" "$ttl"; then
      is_in_flight=1
    else
      # Stale lock: remove and retry exclusive creation
      rm -f "$start_lock" 2>/dev/null || true
      if ( umask 077 && set -C && printf '%s %s\n' "$now" "$$" > "$start_lock" ) 2>/dev/null; then
        acquired_lock=1
      elif [[ -f "$start_lock" ]]; then
        is_in_flight=1
      else
        echo "dyfj: autostart cannot create lock file ${start_lock}" >&2
        return 1
      fi
    fi
  fi

  if [[ "$acquired_lock" == "1" ]]; then
    # Owner-only, and treated as sensitive wholesale: the spawned runtime's
    # entire stdout/stderr lands here, and the launcher can vouch for none of
    # it — the permission bits are the floor, not a claim about the contents.
    (
      umask 077
      mkdir -p "$(dirname "$log")"
      printf -- '── dyfj autostart at %s, socket %s ──\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$sock" >>"$log"
    ) || {
      rm -f "$start_lock" 2>/dev/null || true
      echo "dyfj: autostart cannot write to log file ${log}" >&2
      return 1
    }
    chmod 700 "$(dirname "$log")" 2>/dev/null || true
    chmod 600 "$log" 2>/dev/null || true
    echo "dyfj: runtime not running at ${sock}; starting it (log: ${log})" >&2
    # Mark the background runtime to ignore a terminal SIGINT if it reaches it.
    nohup bash "$LAUNCHER_SOURCE" ${SOCKET_ARGS[@]+"${SOCKET_ARGS[@]}"} start --launcher-autostarted >>"$log" 2>&1 &
    local spawn_pid=$!
    disown "$spawn_pid" 2>/dev/null || true
    # Best-effort update of lock file with spawned child PID
    local tmp_lock="${start_lock}.$$.$RANDOM"
    (
      umask 077
      set -C
      printf '%s %s\n' "$now" "$spawn_pid" >"$tmp_lock"
    ) 2>/dev/null && mv -f "$tmp_lock" "$start_lock" 2>/dev/null || rm -f "$tmp_lock" 2>/dev/null || true
    chmod 600 "$start_lock" 2>/dev/null || true
  else
    echo "dyfj: a runtime start for ${sock} is already in flight (log: ${log}); waiting for it" >&2
  fi

  local i
  for i in $(seq 1 50); do
    if probe_runtime "$@"; then
      rm -f "$start_lock" 2>/dev/null || true
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
  printf '%s' 'DYFJ_SOCKET,DYFJ_WORKSPACE,DYFJ_PROTOTYPE_ROOT,DYFJ_ROOT,DYFJ_NODE_PATH,DYFJ_CODEX_TOOLCHAIN_PATH,DYFJ_CODEX_RUSTUP_HOME,HOME,XDG_RUNTIME_DIR,DYFJ_WORKBENCH_MODEL,DYFJ_WORKBENCH_HINT,DYFJ_WORKBENCH_TIER,DYFJ_MEMORY_MCP_URL,NO_COLOR'
}

prepare_node_path() {
  local candidate
  candidate="${DYFJ_NODE_PATH:-}"
  if [[ -z "$candidate" ]]; then
    candidate="$(command -v node 2>/dev/null)" || return 0
  fi
  if [[ "$candidate" != /* || ! -f "$candidate" || ! -x "$candidate" || "$candidate" == *[,:]* ]]; then
    unset DYFJ_NODE_PATH
    return 0
  fi
  DYFJ_NODE_PATH="$candidate"
  export DYFJ_NODE_PATH
}

has_dot_path_component() {
  case "$1/" in
    *"/./"*|*"/../"*) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_toolchain_path() {
  local candidate no_follow
  candidate="${DYFJ_CODEX_TOOLCHAIN_PATH:-}"
  if [[ -z "$candidate" ]]; then
    unset DYFJ_CODEX_TOOLCHAIN_PATH
    return 0
  fi
  if [[ "$candidate" != /* || "$candidate" == *[,:]* ]]; then
    echo "dyfj: Codex toolchain path must name an absolute, delimiter-safe directory" >&2
    return 1
  fi
  if has_dot_path_component "$candidate"; then
    echo "dyfj: Codex toolchain path must not contain dot components" >&2
    return 1
  fi
  no_follow="$candidate"
  while [[ "$no_follow" != "/" && "$no_follow" == */ ]]; do
    no_follow="${no_follow%/}"
  done
  if [[ "$no_follow" == "/" || ! -d "$candidate" || -L "$no_follow" ]]; then
    echo "dyfj: Codex toolchain directory is unavailable" >&2
    return 1
  fi
  export DYFJ_CODEX_TOOLCHAIN_PATH
}

prepare_rustup_home() {
  local candidate no_follow
  candidate="${DYFJ_CODEX_RUSTUP_HOME:-}"
  if [[ -z "$candidate" ]]; then
    unset DYFJ_CODEX_RUSTUP_HOME
    return 0
  fi
  if [[ "$candidate" != /* || "$candidate" == *[,:]* ]]; then
    echo "dyfj: Codex Rustup home must name an absolute, delimiter-safe directory" >&2
    return 1
  fi
  if has_dot_path_component "$candidate"; then
    echo "dyfj: Codex Rustup home must not contain dot components" >&2
    return 1
  fi
  no_follow="$candidate"
  while [[ "$no_follow" != "/" && "$no_follow" == */ ]]; do
    no_follow="${no_follow%/}"
  done
  if [[ "$no_follow" == "/" || ! -d "$candidate" || -L "$no_follow" ]]; then
    echo "dyfj: Codex Rustup home directory is unavailable" >&2
    return 1
  fi
  export DYFJ_CODEX_RUSTUP_HOME
}

canonical_toolchain_directory() {
  local candidate marked
  candidate="$1"
  CANONICAL_DIRECTORY_RESULT=""
  marked="$(
    cd -P -- "$candidate" 2>/dev/null &&
      pwd -P 2>/dev/null &&
      printf '\001'
  )" || return 1
  marked="${marked%$'\001'}"
  CANONICAL_DIRECTORY_RESULT="${marked%$'\n'}"
  if [[ "$CANONICAL_DIRECTORY_RESULT" == *[,:]* ]]; then
    return 1
  fi
}

route_cli() {
  local resolved default
  resolved="$(resolve_socket_path)"
  default="$(default_socket_path)"

  if [[ "$resolved" != "$default" ]]; then
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
  route="$(route_cli ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"})"
  if autostart_applies ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"} && client_parse_check; then
    autostart="yes"
  else
    autostart="no"
  fi

  if [[ "$LAUNCHER_SUBCOMMAND" == "start" ]]; then
    prepare_node_path
    prepare_toolchain_path || exit 1
    prepare_rustup_home || exit 1
  elif [[ "${DYFJ_LAUNCHER_DRY_RUN:-}" == "1" ]]; then
    prepare_node_path
    prepare_toolchain_path || exit 1
    prepare_rustup_home || exit 1
  fi

  if [[ "${DYFJ_LAUNCHER_DRY_RUN:-}" == "1" ]]; then
    local toolchain_count=0 toolchain_canonical="" rustup_canonical=""
    if [[ -n "${DYFJ_CODEX_TOOLCHAIN_PATH:-}" ]]; then
      if ! canonical_toolchain_directory "$DYFJ_CODEX_TOOLCHAIN_PATH"; then
        echo "dyfj: Codex toolchain directory is unavailable" >&2
        exit 1
      fi
      toolchain_canonical="$CANONICAL_DIRECTORY_RESULT"
      toolchain_count=1
    fi
    if [[ -n "${DYFJ_CODEX_RUSTUP_HOME:-}" ]]; then
      if ! canonical_toolchain_directory "$DYFJ_CODEX_RUSTUP_HOME"; then
        echo "dyfj: Codex Rustup home directory is unavailable" >&2
        exit 1
      fi
      rustup_canonical="$CANONICAL_DIRECTORY_RESULT"
      if [[ -z "$toolchain_canonical" || "$rustup_canonical" != "$toolchain_canonical" ]]; then
        toolchain_count=$((toolchain_count + 1))
      fi
    fi
    printf 'route=%s autostart=%s node_path=%s sock=%s toolchain_directories=%s\n' \
      "$route" "$autostart" "${DYFJ_NODE_PATH:-}" "$(resolve_socket_path)" "$toolchain_count"
    exit 0
  fi

  if [[ "$autostart" == "yes" ]]; then
    ensure_runtime ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"} || exit 1
  fi

  case "$route" in
    compiled)
      DYFJ_PROTOTYPE_ROOT="$(prototype_root)" exec "$(compiled_bin)" ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"}
      ;;
    deno)
      run_deno_cli ${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"}
      ;;
    *)
      echo "dyfj launcher: unknown route '$route'" >&2
      exit 1
      ;;
  esac
}

main "$@"
