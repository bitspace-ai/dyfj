#!/usr/bin/env bash
# Approval by the attested envelope, in the isolated machine (BIT-736). Run as
# root inside the machine, after provision.sh:
#
#   bash approval-probe.sh attest  [--grant attested|none]
#   bash approval-probe.sh calls   --posture strict|operator --grant attested|none
#   bash approval-probe.sh escapes --posture strict|operator --grant attested|none
#   bash approval-probe.sh session-grant --posture strict|operator --grant attested|none
#   bash approval-probe.sh forge   --posture strict|operator --grant attested|none
#   bash approval-probe.sh stale
#
# Each mode sets the envelope grant as asked (through sandbox-install.ts, the
# install path), starts one contained pair with approval-probe.ts as the
# runtime, and prints its lines. On exit it writes the saved grant and plan
# contents back as fresh root-owned files (new inodes, so no descriptor held
# on a file it replaced reaches them), removes its canary, and prints
# "restored". It never removes a file an escape attempt might have written:
# those are evidence. Synthetic data only: the canary is a random string
# made here, never a real credential.
set -uo pipefail

SANDBOX=/usr/libexec/dyfj/dyfj-sandbox
PLANS=/etc/dyfj/l8
HERE=/opt/dyfj/prototype/sandbox/linux
INSTALL=/opt/dyfj/prototype/scripts/sandbox-install.ts
SOCKET=/run/dyfj-exec/exec.sock
GRANT=$PLANS/envelope-grant.json
CANARY_FILE=/run/dyfj/secrets/L9_CANARY
CLEAN_ENV=(env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp USER=dyfj LANG=C.UTF-8)

[[ $(id -u) -eq 0 ]] || { echo "approval-probe.sh must run as root" >&2; exit 2; }
mode=${1:?mode: attest, calls, escapes, session-grant, forge or stale}
shift
posture=strict
grant=none
while [[ $# -gt 0 ]]; do
  case $1 in
    --posture) posture=${2:?}; shift 2 ;;
    --grant) grant=${2:?}; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

saved=$(mktemp -d /root/l9-saved.XXXXXX)
[[ -e $GRANT ]] && cp -p "$GRANT" "$saved/grant"
cp -p "$PLANS/executor.plan.json" "$saved/executor.plan.json"
put_back() { # saved-copy target: a fresh root-owned file, renamed into place
  install -o root -g root -m 0644 "$1" "$2.l9.tmp" && mv -f "$2.l9.tmp" "$2"
}
restore() {
  if [[ -e $saved/grant ]]; then put_back "$saved/grant" "$GRANT"; else rm -f "$GRANT"; fi
  put_back "$saved/executor.plan.json" "$PLANS/executor.plan.json"
  rm -rf "$saved"
  rm -f "$CANARY_FILE"
  echo restored
}
trap restore EXIT

# A synthetic canary in the runtime's secrets: the executor must never see it.
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$CANARY_FILE"
chown dyfj-rt:dyfj-work "$CANARY_FILE"
chmod 0400 "$CANARY_FILE"

set_grant() { # attested | none | other-digest | runtime-writable
  case $1 in
    attested) node "$INSTALL" grant --dir "$PLANS" >/dev/null ;;
    none) rm -f "$GRANT" ;;
    other-digest)
      printf '{"version":1,"executorPolicyDigest":"sha256:%s"}\n' "$(printf '0%.0s' $(seq 1 64))" >"$saved/other"
      put_back "$saved/other" "$GRANT" ;;
    runtime-writable)
      node "$INSTALL" grant --dir "$PLANS" >/dev/null
      chown dyfj-rt:dyfj-work "$GRANT"; chmod 0664 "$GRANT" ;;
    *) echo "unknown grant $1" >&2; exit 2 ;;
  esac
}

pair() { # probe arguments...
  rm -f "$SOCKET"
  "${CLEAN_ENV[@]}" "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" \
    --executor-plan "$PLANS/executor.plan.json" --executor-policy "$PLANS/executor.policy.json" \
    --grant "$GRANT" --socket "$SOCKET" -- node "$HERE/approval-probe.ts" "$@" 2>&1 |
    grep -v '^dyfj-sandbox: runtime \(started\|exited\)'
}

case $mode in
  attest) set_grant "$grant"; pair attest "$posture" ;;
  calls | escapes | session-grant | forge) set_grant "$grant"; pair "$mode" "$posture" ;;
  stale)
    echo "== grant-runtime-writable"
    set_grant runtime-writable; pair attest operator; pair calls operator | head -3
    echo "== grant-other-digest"
    set_grant other-digest; pair attest operator; pair calls operator | head -3
    echo "== plan-changed (the plan file is rewritten after serve starts)"
    set_grant attested
    rm -f "$SOCKET"
    "${CLEAN_ENV[@]}" "$SANDBOX" serve --runtime-plan "$PLANS/runtime.plan.json" \
      --executor-plan "$PLANS/executor.plan.json" --executor-policy "$PLANS/executor.policy.json" \
      --grant "$GRANT" --socket "$SOCKET" -- node "$HERE/approval-probe.ts" attest-after operator \
      >"$saved/plan-changed.log" 2>&1 &
    serve_pid=$!
    for _ in $(seq 1 100); do [[ -S $SOCKET ]] && break; sleep 0.1; done
    printf '\n' >>"$PLANS/executor.plan.json"
    wait "$serve_pid"
    grep -v '^dyfj-sandbox: runtime \(started\|exited\)' "$saved/plan-changed.log"
    put_back "$saved/executor.plan.json" "$PLANS/executor.plan.json"
    echo "== forged supervisor and stale binding"
    pair forge operator
    ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
