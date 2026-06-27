#!/usr/bin/env bash
# dyfj CLI launcher: fast compiled binary on the default UDS path; deno run with a
# dynamically resolved unix: net grant when DYFJ_SOCKET or XDG_RUNTIME_DIR shifts
# the socket away from ~/.dyfj/run/workbench.sock (Deno 2.9 exact-match grants).
set -euo pipefail

resolve_socket_path() {
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

cli_env_allowlist() {
  printf '%s' 'DYFJ_SERVER_URL,DYFJ_SOCKET,DYFJ_WORKSPACE,HOME,XDG_RUNTIME_DIR,DYFJ_WORKBENCH_API_KEY,DYFJ_WORKBENCH_MODEL,DYFJ_WORKBENCH_HINT,DYFJ_WORKBENCH_TIER,DYFJ_UNIX,NO_COLOR'
}

route_cli() {
  local resolved default compiled
  resolved="$(resolve_socket_path)"
  default="$(default_socket_path)"
  compiled="$(compiled_bin)"

  if uses_unix_transport "$@" && [[ "$resolved" != "$default" ]]; then
    printf 'deno'
    return
  fi
  if [[ -x "$compiled" ]]; then
    printf 'compiled'
    return
  fi
  printf 'deno'
}

run_deno_cli() {
  local sock proto
  sock="$(resolve_socket_path)"
  proto="$(prototype_root)"
  exec deno run \
    --allow-env="$(cli_env_allowlist)" \
    --allow-read \
    --allow-write \
    --allow-net="127.0.0.1,localhost,unix:${sock}" \
    --sloppy-imports \
    "${proto}/src/cli.ts" \
    "$@"
}

main() {
  local route
  route="$(route_cli "$@")"

  if [[ "${DYFJ_LAUNCHER_DRY_RUN:-}" == "1" ]]; then
    printf 'route=%s sock=%s\n' "$route" "$(resolve_socket_path)"
    exit 0
  fi

  case "$route" in
    compiled)
      exec "$(compiled_bin)" "$@"
      ;;
    deno)
      run_deno_cli "$@"
      ;;
    *)
      echo "dyfj launcher: unknown route '$route'" >&2
      exit 1
      ;;
  esac
}

main "$@"
