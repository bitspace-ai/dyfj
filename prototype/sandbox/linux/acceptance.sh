#!/usr/bin/env bash
# The isolated machine's acceptance run (BIT-735, design §8, Mac scenario).
# Run as root inside the machine after provision.sh:
#
#   bash /opt/dyfj/prototype/sandbox/linux/acceptance.sh
#
# Synthetic data only: the canaries it plants are random strings made here,
# never a real credential, and it removes them at the end. Each probe prints
# "ok" or "FAIL" with its raw evidence (errno, firewall counter, process
# list); the run exits non-zero if any probe fails.
set -uo pipefail

SANDBOX=/usr/libexec/dyfj/dyfj-sandbox
PLANS=/etc/dyfj/l8
HERE=/opt/dyfj/prototype/sandbox/linux
SOCKET=/run/dyfj-exec/exec.sock
WORK=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).workspace)' "$PLANS/profile.json")
ALLOWED=api.anthropic.com
CLEAN_ENV=(env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp USER=dyfj LANG=C.UTF-8)
fail=0

result() { # pass|fail description evidence
  if [[ $1 == pass ]]; then printf 'ok    %s :: %s\n' "$2" "$3"; else printf 'FAIL  %s :: %s\n' "$2" "$3"; fail=1; fi
}
uid_of() { # role: the uid its plan runs as
  node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).uid))' "$PLANS/$1.plan.json"
}
table_of() { # role: its nftables table, named for its shape and uid
  local shape=$1; [[ $1 == cli ]] && shape=runtime
  echo "dyfj_${shape}_$(uid_of "$1")"
}
counter() { # table: the sum of its reject counters
  nft list table inet "$1" 2>/dev/null | sed -n 's/.*counter packets \([0-9]*\).*/\1/p' | awk '{s+=$1} END {print s+0}'
}
in_role() { # plan cwd-or-empty command...
  local plan=$1 cwd=$2; shift 2
  if [[ -n $cwd ]]; then
    "${CLEAN_ENV[@]}" "$SANDBOX" run --plan "$PLANS/$plan.plan.json" --cwd "$cwd" -- "$@"
  else
    "${CLEAN_ENV[@]}" "$SANDBOX" run --plan "$PLANS/$plan.plan.json" -- "$@"
  fi
}

echo "== platform"
echo "macOS host: (recorded by the operator script)"
echo "kernel: $(uname -r)"
echo "debian: $(cat /etc/debian_version)"
echo "bubblewrap: $(bwrap --version)"
echo "landlock abi: $($SANDBOX abi)"
for role in runtime executor cli; do
  echo "$role policy: $(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(r.roles[process.argv[2]].policyDigest+" plan "+r.roles[process.argv[2]].planDigest)' "$PLANS/receipt.json" "$role")"
done

echo "== canaries (synthetic)"
CANARY_SECRET="canary-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CANARY_TOKEN="canary-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
install -d -o dyfj-rt -g dyfj-work -m 0700 /run/dyfj/secrets
printf '%s' "$CANARY_SECRET" | install -o dyfj-rt -g dyfj-work -m 0400 /dev/stdin /run/dyfj/secrets/CANARY_SECRET
install -d -o root -g root -m 0700 /srv/dyfj/fixtures
printf '%s' "$CANARY_TOKEN" | install -o root -g root -m 0600 /dev/stdin /srv/dyfj/fixtures/service-token.canary
echo "planted a runtime secret and a service-token fixture (random, synthetic)"

echo "== 1. synthetic dependency in the runtime role (no product guards)"
RT_TABLE=$(table_of runtime)
before=$(counter "$RT_TABLE"); before=${before:-0}
dep=$(in_role runtime "" node "$HERE/synthetic-dependency.mjs" "$ALLOWED" 2>&1)
after=$(counter "$RT_TABLE")
while IFS= read -r json; do
  [[ $json == \{* ]] || { echo "      $json"; continue; }
  pass=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).pass))' "$json")
  [[ $pass == true ]] && result pass "runtime: $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).probe)' "$json")" "$json" \
    || result fail "runtime: $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).probe)' "$json")" "$json"
done <<<"$dep"
[[ ${after:-0} -gt ${before:-0} ]] && result pass "runtime: firewall refusals counted" "$RT_TABLE reject counter $before -> $after" \
  || result fail "runtime: firewall refusals counted" "$RT_TABLE reject counter $before -> $after"
cat /run/dyfj/secrets/CANARY_SECRET >/dev/null # the runtime's own secret: readable by it, below

echo "== 2. executor: absent or denied"
EXPROBE='
p() { printf "%s=%s\n" "$1" "$2"; }
p mnt_mac "$(ls /mnt/mac 2>&1 | head -1)"
p users_dir "$(ls /Users 2>&1 | head -1)"
p orbstack_guest "$(ls /opt/orbstack-guest 2>&1 | head -1)"
p mac_command "$(command -v mac open osascript 2>&1 || echo none)"
p ssh_auth_sock "${SSH_AUTH_SOCK:-unset}"
p agent_sockets "$(find / -xdev -type s 2>/dev/null | head -3 | tr "\n" " ")"
p keychain "$(command -v security 2>&1 || echo none)"
p docker_socket "$(ls /var/run/docker.sock /run/docker.sock 2>&1 | head -1)"
p runtime_secret "$(cat /run/dyfj/secrets/CANARY_SECRET 2>&1)"
p token_fixture "$(cat /srv/dyfj/fixtures/service-token.canary 2>&1)"
p processes "$(ls /proc | grep -c "^[0-9]")"
p runtime_environ "$(grep -l DYFJ_EXECUTOR_SOCKET /proc/[0-9]*/environ 2>/dev/null | head -1 || true)"
p interfaces "$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | tr "\n" ,)"
p tcp_shell "$( (exec 3<>/dev/tcp/1.1.1.1/443) 2>&1 | tail -1)"
p tcp_native "$(node -e "require(\"net\").connect(443,\"1.1.1.1\").on(\"error\",e=>console.log(e.code)).on(\"connect\",()=>console.log(\"CONNECTED\"))" 2>&1)"
p tcp_descendant "$(bash -c "bash -c \"(exec 3<>/dev/tcp/1.1.1.1/443) 2>&1\"" | tail -1)"
p write_outside "$(touch /usr/x 2>&1)"
p write_workspace "$(touch /work/executor-marker && echo written)"
p sudo "$(sudo -n true 2>&1 | head -1)"
p su "$(su -c true root </dev/null 2>&1 | head -1)"
p nested_userns "$(unshare -Ur true 2>&1 | head -1)"
p nft_edit "$(nft add table inet escape 2>&1 | head -1)"
p uid "$(id -u)"
'
ex=$(in_role executor /work bash -c "$EXPROBE" 2>&1)
echo "$ex" | sed 's/^/      /'
get() { sed -n "s/^$1=//p" <<<"$ex"; }
expect() { # key description test-pattern(ERE matched means pass)
  local v; v=$(get "$1")
  if grep -qE "$3" <<<"$v"; then result pass "executor: $2" "$1=$v"; else result fail "executor: $2" "$1=$v"; fi
}
expect mnt_mac "no /mnt/mac" "No such file"
expect users_dir "no /Users" "No such file"
expect orbstack_guest "no OrbStack guest tools" "No such file"
expect mac_command "no Mac-command integration" "^none$"
expect ssh_auth_sock "no forwarded agent socket" "^unset$"
expect agent_sockets "no Unix sockets in view" "^$"
expect keychain "no Keychain tool" "^none$"
expect docker_socket "no engine or management socket" "No such file"
expect runtime_secret "cannot read the runtime's tmpfs secret" "No such file|Permission denied"
expect token_fixture "cannot read the service-token fixture" "No such file|Permission denied"
expect runtime_environ "cannot see the runtime's environment" "^$"
expect interfaces "loopback only" "^lo,$"
expect tcp_shell "shell socket refused" "unreachable|refused|not permitted"
expect tcp_native "native-helper socket refused" "ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EACCES|EPERM"
expect tcp_descendant "descendant socket refused" "unreachable|refused|not permitted"
expect write_outside "write outside the workspace refused" "Read-only|Permission denied"
expect write_workspace "write in the workspace allowed" "^written$"
expect sudo "cannot become root (sudo)" "not found|no new privileges|must be owned|effective uid|not allowed|Permission denied"
expect su "cannot become root (su)" "not found|failure|Permission denied|must be run|cannot|Critical error"
expect nested_userns "cannot nest a user namespace" "No space left|Operation not permitted|Permission denied"
expect nft_edit "cannot edit firewall rules" "not found|Operation not permitted|Permission denied"
expect uid "runs as the executor uid" "^$(id -u dyfj-ex)$"
direct=$(runuser -u dyfj-ex -- cat /run/dyfj/secrets/CANARY_SECRET 2>&1)
grep -q "Permission denied" <<<"$direct" && result pass "executor uid outside any sandbox cannot read the runtime secret" "$direct" \
  || result fail "executor uid outside any sandbox cannot read the runtime secret" "$direct"
grep -qF "$CANARY_SECRET" <<<"$ex$direct" && result fail "no secret canary in any executor output" "canary leaked" \
  || result pass "no secret canary in any executor output" "not present"
grep -qF "$CANARY_TOKEN" <<<"$ex$direct" && result fail "no token canary in any executor output" "canary leaked" \
  || result pass "no token canary in any executor output" "not present"

echo "== 3. lease: killing the runtime expires the executor"
rm -f "$SOCKET"
"${CLEAN_ENV[@]}" "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" --executor-plan "$PLANS/executor.plan.json" \
  --socket "$SOCKET" -- node "$HERE/loop-probe.ts" hold >/tmp/l8-lease.log 2>&1 &
serve_pid=$!
for _ in $(seq 1 100); do pgrep -u dyfj-ex -x sleep >/dev/null && break; sleep 0.1; done
sleeper=$(pgrep -u dyfj-ex -x sleep | head -1)
runtime_node=$(pgrep -u dyfj-rt -f loop-probe.ts | head -1)
if [[ -n $sleeper && -n $runtime_node ]]; then
  t0=$(date +%s%N)
  kill -9 "$runtime_node"
  for _ in $(seq 1 200); do kill -0 "$sleeper" 2>/dev/null || break; sleep 0.01; done
  t1=$(date +%s%N)
  if kill -0 "$sleeper" 2>/dev/null; then
    result fail "executor ends when the runtime is killed" "executor sleep $sleeper still alive after 2 s"
  else
    result pass "executor ends when the runtime is killed" "runtime node $runtime_node SIGKILL; executor sleep $sleeper gone in $(( (t1 - t0) / 1000000 )) ms; $(grep -m1 'lease expired' /tmp/l8-lease.log)"
  fi
else
  result fail "executor ends when the runtime is killed" "setup: sleeper=${sleeper:-none} runtime=${runtime_node:-none}; $(tail -3 /tmp/l8-lease.log)"
fi
wait "$serve_pid" 2>/dev/null
[[ ! -S $SOCKET ]] && result pass "the transport socket is removed with the lease" "absent" \
  || result fail "the transport socket is removed with the lease" "still present"

echo "== 4. real loop: runtime edits, executor tests and commits (product bash tool)"
rm -rf "${WORK:?}"/* "${WORK:?}"/.git 2>/dev/null
loop=$("${CLEAN_ENV[@]}" "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" --executor-plan "$PLANS/executor.plan.json" \
  --socket "$SOCKET" -- node "$HERE/loop-probe.ts" 2>&1)
echo "$loop" | sed 's/^/      /'
grep -q 'tests in the executor.*exit 0.*pass 1.*fail 0' <<<"$loop" && result pass "loop: tests pass in the executor" "$(grep 'tests in the executor' <<<"$loop")" \
  || result fail "loop: tests pass in the executor" "see output"
grep -q 'local commit in the executor.*exit 0.*L8: harmless edit' <<<"$loop" && result pass "loop: local commit made" "$(grep 'local commit' <<<"$loop")" \
  || result fail "loop: local commit made" "see output"
grep -q "\"output\":\"exit 0\\\\ndyfj-ex\"" <<<"$loop" && result pass "loop: commands ran as the executor uid" "dyfj-ex" \
  || result fail "loop: commands ran as the executor uid" "$(grep whoami <<<"$loop")"

echo "== 5. a git hook the executor plants never runs outside the executor"
EX_UID=$(uid_of executor); RT_UID=$(uid_of runtime)
rm -f "$WORK"/.l8-ran-*
plant='
printf "#!/bin/sh\necho pre-commit >> /work/.l8-ran-\$(id -u)\n" > .git/hooks/pre-commit
printf "#!/bin/sh\necho fsmonitor >> /work/.l8-ran-\$(id -u)\n" > .git/fsmon.sh
chmod +x .git/hooks/pre-commit .git/fsmon.sh
git config core.fsmonitor /work/.git/fsmon.sh && echo planted'
planted=$(in_role executor /work bash -c "$plant" 2>&1)
[[ $planted == planted ]] && result pass "hooks: the executor can write git metadata (planted a hook and an fsmonitor)" "$planted" \
  || result fail "hooks: the executor can write git metadata (planted a hook and an fsmonitor)" "$planted"
gitrun=$("${CLEAN_ENV[@]}" "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" --executor-plan "$PLANS/executor.plan.json" \
  --socket "$SOCKET" -- node "$HERE/loop-probe.ts" git 2>&1)
echo "$gitrun" | sed 's/^/      /'
markers=$(cd "$WORK" && ls .l8-ran-* 2>/dev/null | tr '\n' ' ')
grep -q 'L8: note' <<<"$(in_role executor /work git log --oneline -1 2>&1)" && result pass "hooks: the runtime's git tool committed through the executor" "$(in_role executor /work git log --oneline -1 2>&1)" \
  || result fail "hooks: the runtime's git tool committed through the executor" "see output"
[[ ! -e $WORK/.l8-ran-$RT_UID ]] && result pass "hooks: nothing ran as the runtime uid" "markers: ${markers:-none} (executor uid $EX_UID, runtime uid $RT_UID)" \
  || result fail "hooks: nothing ran as the runtime uid" "markers: $markers"
[[ -e $WORK/.l8-ran-$EX_UID ]] && result pass "hooks: the planted hook ran only inside the executor" "$(tr '\n' ' ' <"$WORK/.l8-ran-$EX_UID")" \
  || result fail "hooks: the planted hook ran only inside the executor" "no executor marker; markers: ${markers:-none}"
rm -f "$WORK"/.l8-ran-*
exported=$(in_role executor /work git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat format-patch --stdout --no-ext-diff --no-textconv --root HEAD -- 2>&1 | grep -c '^From ')
after_export=$(cd "$WORK" && ls .l8-ran-* 2>/dev/null | tr '\n' ' ')
[[ -z $after_export && $exported -ge 1 ]] && result pass "hooks: the export runs no planted hook or fsmonitor" "$exported patch(es), markers: none" \
  || result fail "hooks: the export runs no planted hook or fsmonitor" "patches $exported, markers: ${after_export:-none}"
cli_view=$(in_role cli "" bash -c 'ls /work/.git/hooks/pre-commit /work/greeting.mjs 2>&1 | head -2 | tr "\n" " "')
grep -q "No such file" <<<"$cli_view" && ! grep -q "^/work/.git/hooks/pre-commit$" <<<"$cli_view" \
  && result pass "hooks: the CLI's workspace is not the one the executor plants in" "$cli_view" \
  || result fail "hooks: the CLI's workspace is not the one the executor plants in" "$cli_view"
ex_view=$(in_role executor /work bash -c 'ls /srv/dyfj/work 2>&1 | head -1')
grep -q "No such file" <<<"$ex_view" && result pass "hooks: the executor cannot reach the CLI's workspace" "$ex_view" \
  || result fail "hooks: the executor cannot reach the CLI's workspace" "$ex_view"

echo "== 6. role firewalls stay separate (CLI and runtime, both orders, and a restart)"
CLI_TABLE=$(table_of cli)
refused() { # role: does a raw connect from the role to a disallowed address fail with an errno?
  in_role "$1" "" node -e 'require("net").connect(443,"1.1.1.1").on("error",e=>{console.log(e.code);process.exit()}).on("connect",()=>{console.log("CONNECTED");process.exit()});setTimeout(()=>{console.log("TIMEOUT");process.exit()},5000)' 2>&1
}
intact() { # table uid: the table exists and still sends its uid to the role chain
  nft list chain inet "$1" output 2>/dev/null | grep -q "meta skuid $2 jump role"
}
both() { # step
  local rt cli
  rt=$(refused runtime); cli=$(refused cli)
  if intact "$RT_TABLE" "$(uid_of runtime)" && intact "$CLI_TABLE" "$(uid_of cli)" &&
     [[ $rt == ECONNREFUSED && $cli == ECONNREFUSED ]]; then
    result pass "firewalls: $1" "$RT_TABLE and $CLI_TABLE intact; runtime $rt, cli $cli"
  else
    result fail "firewalls: $1" "runtime table $(intact "$RT_TABLE" "$(uid_of runtime)" && echo intact || echo missing) ($rt); cli table $(intact "$CLI_TABLE" "$(uid_of cli)" && echo intact || echo missing) ($cli)"
  fi
}
nft delete table inet "$RT_TABLE" 2>/dev/null; nft delete table inet "$CLI_TABLE" 2>/dev/null
in_role cli "" true; in_role runtime "" true
both "CLI started, then runtime"
nft delete table inet "$RT_TABLE" 2>/dev/null; nft delete table inet "$CLI_TABLE" 2>/dev/null
in_role runtime "" true; in_role cli "" true
both "runtime started, then CLI"
in_role runtime "" true
both "runtime restarted while the CLI's rules stand"
in_role cli "" true
both "CLI restarted while the runtime's rules stand"

echo "== 7. timings"
t0=$(date +%s%N); in_role executor /work true; t1=$(date +%s%N)
echo "single executor sandbox start (run, true): $(( (t1 - t0) / 1000000 )) ms"
grep 'warm dispatch' <<<"$loop" | sed 's/^/      /'

echo "== cleanup"
rm -f /run/dyfj/secrets/CANARY_SECRET /srv/dyfj/fixtures/service-token.canary
rmdir /srv/dyfj/fixtures 2>/dev/null
echo "removed the canaries"
exit $fail
