#!/usr/bin/env bash
# One attended Workbench session in the isolated machine (BIT-779). Run as
# root inside the machine, by the operator's `dyfj-l8 work` over one `orb`
# session from the operator's terminal:
#
#   bash l8-work.sh <run> [--model <slug>] [--approve-paid] [--probe]
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
#      this script, a hangup, or a failed start): stops the pair (the
#      supervisor ends the lease and kills any executor), removes both
#      sockets and each delivered file named for a secret the runtime may
#      take, and releases the lock.
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

# `l8-work.sh stop` ends a session whose terminal went away. It signals the
# session's script, whose own cleanup runs, and any pair still serving a
# work run's plans, selected by pid. It then takes the session lock, so no
# new session can start while it removes what a session leaves, and it
# removes nothing unless every such pair has exited.
if [[ ${1:-} == stop ]]; then
  holder=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ $holder =~ ^[0-9]+$ ]] && kill -TERM "$holder" 2>/dev/null
  for pid in $(work_serves); do kill -TERM "$pid" 2>/dev/null && echo "signalled serve $pid"; done
  exec 9>"$LOCK"
  flock -w 10 9 || { echo "dyfj-l8: a session still holds the lock (pid ${holder:-unknown}); nothing removed" >&2; exit 1; }
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
  { echo "usage: l8-work.sh <run> [--model <slug>] [--approve-paid] [--probe] (not run-0001)" >&2; exit 2; }
shift
model=
approve_paid=
probe=
while [[ $# -gt 0 ]]; do
  case $1 in
    --model) model=${2:?--model needs a slug}; shift 2 ;;
    --approve-paid) approve_paid=1; shift ;;
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
cleanup() {
  trap - EXIT INT TERM HUP
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
# Written once cleanup is in place, so every exit from here removes it.
echo $$ >"$PIDFILE"

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
if [[ -n $probe ]]; then
  runuser -u dyfj-rt -- setpriv --no-new-privs "${client_env[@]}" PATH=/usr/local/bin:/usr/bin:/bin \
    node "$CODE/sandbox/linux/work-probe.ts" "$SOCKET"
else
  repl_args=(--workspace /work)
  [[ -n $model ]] && repl_args+=(--model "$model")
  [[ -n $approve_paid ]] && repl_args+=(--approve-paid)
  runuser -u dyfj-rt -- setpriv --no-new-privs "${client_env[@]}" "$REPL" "${repl_args[@]}"
fi
