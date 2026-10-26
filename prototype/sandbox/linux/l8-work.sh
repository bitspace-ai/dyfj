#!/usr/bin/env bash
# One attended Workbench session in the isolated machine (BIT-779). Run as
# root inside the machine, by the operator's `dyfj-l8 work` over one `orb`
# session from the operator's terminal:
#
#   bash l8-work.sh <run> [--model <slug>] [--approve-paid] [--budget-<limit> <usd>]... [--probe]
#
# <run> names a run that `dyfj-l8 work` seeded: its workspace is
# /srv/dyfj/work/<run> and its plans are in /etc/dyfj/l8/runs/<run>. The
# script:
#
#   1. takes the machine's one session lock, and says whether the envelope is
#      granted for this run's executor policy;
#   2. hands the store's runtime password to the runtime for this session;
#   3. starts the attested pair (`dyfj-sandbox serve`, with the run's grant
#      file), the runtime being sandbox-runtime.ts, which reads the delivered
#      secrets into the runtime's environment;
#   4. attaches the Workbench REPL to the runtime's socket in this terminal,
#      as dyfj-rt, with no new privileges and a cleared environment (with
#      --probe, work-probe.ts instead, for acceptance);
#   5. on any exit once the lock is taken (the REPL ending, Ctrl-C reaching
#      this script, a hangup, a TERM from `stop`, or a failed start): stops
#      the client and the pair (the supervisor ends the lease and kills any
#      executor), removes both sockets and each delivered file named for a
#      secret the runtime may take, and releases the lock. The client runs
#      as a child the script waits on, so a signal reaches the cleanup at
#      once, even while the client is stuck.
#
# Nothing here prints a secret. Delivered secrets are named, never read.
set -uo pipefail

SANDBOX=/usr/libexec/dyfj/dyfj-sandbox
REPL=/usr/libexec/dyfj/dyfj-repl
CODE=/opt/dyfj/prototype
EXEC_SOCKET=/run/dyfj-exec/exec.sock
RUNTIME_HOME=/srv/dyfj/state/runtime
# The runtime's socket, as the runtime sees it (its home is /home in its
# sandbox) and as the machine sees it.
SOCKET_IN_ROLE=/home/.dyfj/run/workbench.sock
SOCKET=$RUNTIME_HOME/.dyfj/run/workbench.sock
SECRETS=/run/dyfj/secrets
LOCK=/run/dyfj/l8-work.lock
PIDFILE=/run/dyfj/l8-work.pid
LOGS=/srv/dyfj/state/l8-logs
DOLT_PASSWORD_FILE=/etc/dyfj/dolt-runtime.password

[[ $(id -u) -eq 0 ]] || { echo "l8-work.sh must run as root" >&2; exit 2; }

# Each name the runtime may take from a delivered file, from the code that
# reads them, so cleanup removes exactly those. Listed before anything is
# taken or written, so a failure here leaves nothing behind.
mapfile -t DELIVERABLE < <(cd "$CODE" && node -e \
  'import("./scripts/sandbox-runtime.ts").then((m) => console.log(m.deliverableNames().join("\n")))')
[[ ${#DELIVERABLE[@]} -gt 0 ]] || { echo "cannot list the runtime's secret names" >&2; exit 1; }

# The pids of `dyfj-sandbox serve` processes serving a work run's plans.
work_serves() {
  local pid
  for pid in $(pgrep -x dyfj-sandbox || true); do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- ' serve .*--runtime-plan /etc/dyfj/l8/runs/' && echo "$pid"
  done
}

# The start time of process $1 (field 22 of /proc/<pid>/stat, in clock
# ticks since boot), or nothing. A pid that names another process after
# reuse has another start time.
start_time() {
  local stat rest fields
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  rest=${stat##*) }
  read -r -a fields <<<"$rest"
  echo "${fields[19]:-}"
}

# The session's identity, as the pid file records it: "<pid> <start time>".
session_identity() { echo "$1 $(start_time "$1")"; }

# Whether the pid file names a live l8-work.sh session: the same pid, the
# same start time, and this script on its command line.
is_session() { # pid recorded-start-time
  [[ $1 =~ ^[0-9]+$ && -n $2 && $(start_time "$1") == "$2" ]] &&
    tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q -- ' /opt/dyfj/prototype/sandbox/linux/l8-work.sh '
}

# `l8-work.sh stop` ends a session whose terminal went away.
# - When the lock is free, no session is live, so it signals no session
#   script: a pid file left by a killed session is reported and removed. It
#   stops any pair still serving a work run's plans, each checked by its
#   command line, since a killed session can leave one behind.
# - When the lock is held, it signals the session script only if the pid
#   file still names that script (same pid, same start time, same command),
#   checked immediately before the signal. A pid reused in the instant
#   between that check and the signal is not excluded. The session's own
#   cleanup then stops its pair. If the pid file does not name a live
#   session, it signals nothing at all and stops.
# It then takes the lock, so no new session can start while it removes
# what a session leaves, and it removes nothing unless every such pair has
# exited.
if [[ ${1:-} == stop ]]; then
  exec 9>"$LOCK"
  read -r holder holder_start <"$PIDFILE" 2>/dev/null || { holder=; holder_start=; }
  if flock -n 9; then
    [[ -n $holder ]] && echo "dyfj-l8: no session holds the lock; the pid file named $holder, which was not signalled"
    for pid in $(work_serves); do kill -TERM "$pid" 2>/dev/null && echo "signalled serve $pid"; done
  elif is_session "$holder" "$holder_start"; then
    kill -TERM "$holder" 2>/dev/null && echo "signalled session $holder"
  else
    echo "dyfj-l8: the lock is held, but the pid file (${holder:-empty}) does not name a live session; nothing signalled, nothing removed" >&2
    exit 1
  fi
  flock -w 10 9 || { echo "dyfj-l8: a session still holds the lock; nothing removed" >&2; exit 1; }
  for _ in $(seq 1 50); do [[ -z $(work_serves) ]] && break; sleep 0.1; done
  left=$(work_serves | tr '\n' ' ')
  [[ -z $left ]] || { echo "dyfj-l8: serve still running (pid $left); nothing removed" >&2; exit 1; }
  rm -f "$EXEC_SOCKET" "$SOCKET" "$PIDFILE"
  for name in "${DELIVERABLE[@]}"; do rm -f "${SECRETS:?}/$name"; done
  echo "dyfj-l8: no session is live; its sockets and the runtime's secret files are removed"
  exit 0
fi

RUN=${1:-}
[[ $RUN =~ ^[a-z0-9][a-z0-9-]{0,62}$ && $RUN != run-0001 ]] ||
  { echo "usage: l8-work.sh <run> [--model <slug>] [--approve-paid] [--budget-<limit> <usd>]... [--probe] (not run-0001)" >&2; exit 2; }
shift
model=
approve_paid=
probe=
budget_args=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --model) model=${2:?--model needs a slug}; shift 2 ;;
    --approve-paid) approve_paid=1; shift ;;
    --budget-turn|--budget-session|--budget-day|--budget-per-call|--budget-runaway)
      [[ ${2:-} =~ ^[0-9]{1,4}(\.[0-9]{1,4})?$ ]] || { echo "$1 needs a dollar amount such as 4 or 0.50" >&2; exit 2; }
      budget_args+=("$1" "$2"); shift 2 ;;
    --probe) probe=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -z $model || $model =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$ ]] || { echo "model must be a plain slug" >&2; exit 2; }

PLANS=/etc/dyfj/l8/runs/$RUN
for file in runtime.plan.json executor.plan.json executor.policy.json; do
  [[ -f $PLANS/$file ]] || { echo "no $PLANS/$file: seed the run with dyfj-l8 work first" >&2; exit 2; }
done
GRANT=$PLANS/envelope-grant.json

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another dyfj-l8 session is live (pid $(cat "$PIDFILE" 2>/dev/null || echo unknown)); end it, or run dyfj-l8 stop" >&2
  exit 3
fi

serve_pid=
client_pid=
cleanup() {
  trap - EXIT INT TERM HUP
  if [[ -n $client_pid ]] && kill -0 "$client_pid" 2>/dev/null; then
    kill -TERM "$client_pid" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$client_pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$client_pid" 2>/dev/null
  fi
  if [[ -n $serve_pid ]] && kill -0 "$serve_pid" 2>/dev/null; then
    # serve leads its own process group (setsid). Its runtime and executors
    # die with it (--die-with-parent), and the lease ends.
    kill -TERM -- "-$serve_pid" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$serve_pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$serve_pid" 2>/dev/null
  fi
  rm -f "$EXEC_SOCKET" "$SOCKET"
  for name in "${DELIVERABLE[@]}"; do rm -f "${SECRETS:?}/$name"; done
  rm -f "$PIDFILE"
  echo "dyfj-l8: session ended; the lease is released and the runtime's secrets are removed"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Written once cleanup is in place, so every exit from here removes it. It
# records this script's pid and start time, which `stop` checks before it
# signals anything.
session_identity $$ >"$PIDFILE"

# The grant applies only when it names this run's executor policy.
grant_state=$(node -e '
  const fs = require("fs");
  const [grantPath, policyPath] = process.argv.slice(1);
  const digest = JSON.parse(fs.readFileSync(policyPath, "utf8")).identity.digest;
  let granted = "";
  try { granted = JSON.parse(fs.readFileSync(grantPath, "utf8")).executorPolicyDigest; } catch {}
  console.log(granted === digest ? `present ${digest}` : `none ${digest}`);
' "$GRANT" "$PLANS/executor.policy.json")
if [[ $grant_state == present* ]]; then
  echo "dyfj-l8: grant present for ${grant_state#present } (bash and git run in the executor without prompts)"
else
  echo "dyfj-l8: no grant for ${grant_state#none } (every bash and git call asks)"
fi

install -d -o dyfj-rt -g dyfj-work -m 0700 "$SECRETS"
if [[ -s $DOLT_PASSWORD_FILE ]]; then
  install -o dyfj-rt -g dyfj-work -m 0400 "$DOLT_PASSWORD_FILE" "$SECRETS/DOLT_PASSWORD"
else
  echo "dyfj-l8: no store password at $DOLT_PASSWORD_FILE; re-provision the machine" >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$LOGS"
log=$LOGS/$RUN.log
rm -f "$EXEC_SOCKET" "$SOCKET"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home USER=dyfj LANG=C.UTF-8 \
  DYFJ_SOCKET="$SOCKET_IN_ROLE" DOLT_HOST=127.0.0.1 DOLT_PORT=3306 DOLT_USER=dyfj_runtime DOLT_DATABASE=dolt \
  setsid "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" --executor-plan "$PLANS/executor.plan.json" \
  --executor-policy "$PLANS/executor.policy.json" --grant "$GRANT" --socket "$EXEC_SOCKET" \
  -- node "$CODE/scripts/sandbox-runtime.ts" >>"$log" 2>&1 </dev/null &
serve_pid=$!

for _ in $(seq 1 100); do
  [[ -S $SOCKET ]] && break
  kill -0 "$serve_pid" 2>/dev/null || break
  sleep 0.2
done
if [[ ! -S $SOCKET ]]; then
  echo "dyfj-l8: the runtime did not start; the end of $log:" >&2
  tail -n 20 "$log" >&2
  exit 1
fi
grep -h '^dyfj-sandbox: enforcement probe' "$log" | tail -n 1

client_env=(env -i PATH=/usr/bin:/bin HOME="$RUNTIME_HOME" LANG=C.UTF-8 TERM="${TERM:-xterm-256color}" DYFJ_SOCKET="$SOCKET")
# The client runs asynchronously and the script waits on it: bash runs a
# trap only between commands, so a foreground client would hold off the
# cleanup until it exits. `<&0` keeps the terminal as its stdin, which bash
# would otherwise replace with /dev/null for an asynchronous command.
if [[ -n $probe ]]; then
  runuser -u dyfj-rt -- setpriv --no-new-privs "${client_env[@]}" PATH=/usr/local/bin:/usr/bin:/bin \
    node "$CODE/sandbox/linux/work-probe.ts" "$SOCKET" <&0 &
else
  repl_args=(--workspace /work)
  [[ -n $model ]] && repl_args+=(--model "$model")
  [[ -n $approve_paid ]] && repl_args+=(--approve-paid)
  repl_args+=(${budget_args[@]+"${budget_args[@]}"})
  runuser -u dyfj-rt -- setpriv --no-new-privs "${client_env[@]}" "$REPL" "${repl_args[@]}" <&0 &
fi
client_pid=$!
# The session's exit status is the client's. Cleanup runs on the way out
# and does not change it.
wait "$client_pid"
status=$?
client_pid=
exit "$status"
