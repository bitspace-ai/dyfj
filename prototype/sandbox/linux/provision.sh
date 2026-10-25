#!/usr/bin/env bash
# Provision an OrbStack isolated machine as DYFJ's contained Linux target
# (BIT-735). Run once as root inside the machine, after the operator's Mac
# script has pushed the staging directory:
#
#   bash provision.sh <staging-dir> <run-id>
#
# The staging directory holds dyfj.bundle (a git bundle of the repository),
# dyfj-sandbox (the launcher) and dyfj-repl (the Workbench REPL), both built
# for linux-arm64, and this script. Nothing here reads a secret. It makes one:
# the local Dolt store's runtime password, random, kept in a root-only file
# in the machine and never printed (BIT-779). The Node and Dolt archives are pinned to a
# version and a SHA-256 digest; the two CLIs to an npm version, without a
# digest; the Debian packages come from the distribution's signed archive at
# whatever version it serves. The script ends by checking that the Mac
# integrations are absent and that no agent uid can escalate; any failed check
# fails it.
set -euo pipefail

STAGING=${1:?staging directory}
RUN=${2:?run id}
[[ $RUN =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "run id must be a short lowercase name" >&2; exit 2; }
[[ $(id -u) -eq 0 ]] || { echo "provision.sh must run as root" >&2; exit 2; }
grep -q '^ID=debian' /etc/os-release || { echo "provision.sh expects Debian" >&2; exit 2; }

NODE_VERSION=26.11.1
NODE_SHA256=0945e2cde6aa0f54d980f03874dfe5cf3a549ce714c7fb9019e591ce0accf282
DOLT_VERSION=2.3.1
# Upstream publishes no checksum for this archive: the digest was taken from
# the release download on 2026-10-22 and pins it from then on.
DOLT_SHA256=33ce669f922a3424f271a9905b815ea442133a0504eea1f43b07cb5b1fef589e
CLAUDE_CODE_VERSION=2.1.304
CODEX_VERSION=0.163.0

# Agent uids share one primary group, so a file one role writes in the
# workspace stays writable by the others (the launcher drops supplementary
# groups). The executor socket is guarded by the peer's uid, not its group.
WORK_GID=2000
RT_UID=2001
EX_UID=2002
CLI_UID=2003
DB_UID=2004

fetch() { # url sha256 out
  curl -fsSL --retry 3 -o "$3" "$1"
  printf '%s  %s\n' "$2" "$3" | sha256sum -c --status - || { echo "digest mismatch: $1" >&2; exit 1; }
}

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bubblewrap nftables git ca-certificates curl xz-utils acl procps >/dev/null

echo "== node $NODE_VERSION"
if [[ $(/usr/local/bin/node --version 2>/dev/null) != "v$NODE_VERSION" ]]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" "$NODE_SHA256" /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
  rm /tmp/node.tar.xz
fi

echo "== dolt $DOLT_VERSION"
if ! /usr/local/bin/dolt version 2>/dev/null | grep -qF "$DOLT_VERSION"; then
  fetch "https://github.com/dolthub/dolt/releases/download/v$DOLT_VERSION/dolt-linux-arm64.tar.gz" "$DOLT_SHA256" /tmp/dolt.tgz
  tar -xzf /tmp/dolt.tgz -C /tmp
  install -m 0755 /tmp/dolt-linux-arm64/bin/dolt /usr/local/bin/dolt
  rm -rf /tmp/dolt.tgz /tmp/dolt-linux-arm64
fi

echo "== CLIs"
# Claude Code's install script fetches its native binary, so it alone may
# run one; every other package's scripts stay off.
npm install -g --no-fund --no-audit --allow-scripts=@anthropic-ai/claude-code \
  "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" "@openai/codex@$CODEX_VERSION" >/dev/null

echo "== users"
getent group dyfj-work >/dev/null || groupadd -g "$WORK_GID" dyfj-work
mkuser() { # name uid home
  getent passwd "$1" >/dev/null ||
    useradd -u "$2" -g dyfj-work -d "$3" -M -s /usr/sbin/nologin "$1"
}
mkuser dyfj-rt "$RT_UID" /srv/dyfj/state/runtime
mkuser dyfj-ex "$EX_UID" /nonexistent
mkuser dyfj-cli "$CLI_UID" /srv/dyfj/state/cli
getent group dyfj-db >/dev/null || groupadd -g "$DB_UID" dyfj-db
getent passwd dyfj-db >/dev/null ||
  useradd -u "$DB_UID" -g dyfj-db -d /srv/dyfj/dolt -M -s /usr/sbin/nologin dyfj-db

echo "== layout"
install -d -o root -g root -m 0755 /srv/dyfj /srv/dyfj/state /srv/dyfj/work /etc/dyfj /etc/dyfj/l8 /usr/libexec/dyfj
install -d -o dyfj-rt -g dyfj-work -m 0700 /srv/dyfj/state/runtime
install -d -o dyfj-cli -g dyfj-work -m 0700 /srv/dyfj/state/cli
install -d -o dyfj-db -g dyfj-db -m 0700 /srv/dyfj/dolt
# The executor runs the runtime's git, so it owns the run's workspace and
# git's ownership check passes even with the system config off. The CLI has a
# workspace of its own, apart from the one the executor can plant git hooks
# in, because it runs git with its own login and egress.
install -d -o dyfj-ex -g dyfj-work -m 2770 "/srv/dyfj/work/$RUN"
install -d -o dyfj-cli -g dyfj-work -m 2770 "/srv/dyfj/work/$RUN-cli"
install -o root -g root -m 0755 "$STAGING/dyfj-sandbox" /usr/libexec/dyfj/dyfj-sandbox
install -o root -g root -m 0755 "$STAGING/dyfj-repl" /usr/libexec/dyfj/dyfj-repl

# /run is a tmpfs, so the secrets directory and the executor socket's
# directory are recreated at every boot by the tmpfiles rule. The broker
# writes each secret into the first as a 0400 file.
cat >/etc/tmpfiles.d/dyfj.conf <<EOF
d /run/dyfj 0755 root root -
d /run/dyfj/secrets 0700 dyfj-rt dyfj-work -
d /run/dyfj-exec 0750 root dyfj-work -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/dyfj.conf 2>/dev/null || {
  install -d -o dyfj-rt -g dyfj-work -m 0700 /run/dyfj/secrets
  install -d -o root -g dyfj-work -m 0750 /run/dyfj-exec
}

echo "== workbench code"
rm -rf /opt/dyfj
git -c init.defaultBranch=main -c advice.detachedHead=false clone -q --no-hardlinks "$STAGING/dyfj.bundle" /opt/dyfj
git -C /opt/dyfj remote remove origin
(cd /opt/dyfj && npm ci --no-fund --no-audit --ignore-scripts >/dev/null)
chown -R root:root /opt/dyfj
chmod -R go-w /opt/dyfj

echo "== local dolt (an empty store; it owns no memory class yet)"
# Dolt keeps its global config in $HOME/.dolt, so the store has its own
# directory beneath the home.
if [[ ! -d /srv/dyfj/dolt/data/.dolt ]]; then
  runuser -u dyfj-db -- env HOME=/srv/dyfj/dolt bash -c 'cd /srv/dyfj/dolt
    dolt config --global --get user.name >/dev/null 2>&1 ||
      { dolt config --global --add user.name dyfj-db && dolt config --global --add user.email dyfj-db@localhost; } >/dev/null
    mkdir -p /srv/dyfj/dolt/data && cd /srv/dyfj/dolt/data && dolt init >/dev/null'
fi
if [[ -d /run/systemd/system ]]; then
  cat >/etc/systemd/system/dyfj-dolt.service <<'EOF'
[Unit]
Description=DYFJ local Dolt store for the isolated machine
After=network.target

[Service]
User=dyfj-db
Group=dyfj-db
Environment=HOME=/srv/dyfj/dolt
WorkingDirectory=/srv/dyfj/dolt/data
ExecStart=/usr/local/bin/dolt sql-server --host 127.0.0.1 --port 3306
Restart=on-failure
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now dyfj-dolt.service >/dev/null 2>&1
fi

echo "== local dolt schema and runtime user"
# The runtime refuses a store without its tables, so the store gets the
# canonical schema once, when its database does not exist yet; an existing
# database is left as it is. The runtime connects as dyfj_runtime with the
# grants schema/README.md lists, never as root. Its password is made here,
# kept in a root-only file, and handed to the runtime only for a live
# session (l8-work.sh). Statements reach dolt on stdin, so the password is in
# no argument list.
DOLT_PASSWORD_FILE=/etc/dyfj/dolt-runtime.password
dolt_root() { # dolt arguments...; run as the store's uid, from its home
  (cd /srv/dyfj/dolt && runuser -u dyfj-db -- env HOME=/srv/dyfj/dolt DOLT_CLI_PASSWORD= \
    dolt --host 127.0.0.1 --port 3306 --no-tls --user root "$@")
}
for _ in $(seq 1 50); do dolt_root sql -q 'select 1' >/dev/null 2>&1 && break; sleep 0.2; done
if ! dolt_root sql -r csv -q 'show databases' | grep -qx dolt; then
  dolt_root sql -q 'CREATE DATABASE dolt'
  for file in /opt/dyfj/schema/current/*.sql /opt/dyfj/schema/catalog/*.sql; do
    dolt_root --use-db dolt sql <"$file" >/dev/null
  done
  echo "created database dolt from schema/current and schema/catalog"
fi
if [[ ! -s $DOLT_PASSWORD_FILE ]] ||
  ! dolt_root sql -r csv -q "select user from mysql.user where user='dyfj_runtime'" | grep -qx dyfj_runtime; then
  (umask 077 && head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DOLT_PASSWORD_FILE")
  chown root:root "$DOLT_PASSWORD_FILE"
  chmod 0600 "$DOLT_PASSWORD_FILE"
  # Dropped and created again rather than revoked: schema/README.md.
  {
    echo "DROP USER IF EXISTS 'dyfj_runtime'@'localhost';"
    echo "CREATE USER 'dyfj_runtime'@'localhost' IDENTIFIED BY '$(cat "$DOLT_PASSWORD_FILE")';"
    echo "GRANT SELECT, INSERT ON dolt.events TO 'dyfj_runtime'@'localhost';"
    echo "GRANT SELECT, INSERT, UPDATE ON dolt.sessions TO 'dyfj_runtime'@'localhost';"
    echo "GRANT SELECT, INSERT, UPDATE ON dolt.memories TO 'dyfj_runtime'@'localhost';"
    echo "GRANT SELECT ON dolt.models TO 'dyfj_runtime'@'localhost';"
    echo "GRANT SELECT ON dolt.prompts TO 'dyfj_runtime'@'localhost';"
  } | dolt_root sql >/dev/null
  echo "created the dyfj_runtime user"
fi

echo "== role plans"
cat >/etc/dyfj/l8/profile.json <<EOF
{
  "identity": {
    "principal": "operator",
    "job": "l8-attended",
    "run": "$RUN",
    "repositories": ["bitspace-ai/dyfj"],
    "expiresAt": "$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)"
  },
  "workspace": "/srv/dyfj/work/$RUN",
  "acceptAddressSet": ["api.anthropic.com:443", "api.openai.com:443"],
  "runtime": { "uid": $RT_UID, "gid": $WORK_GID },
  "executor": { "uid": $EX_UID, "gid": $WORK_GID },
  "cli": {
    "uid": $CLI_UID,
    "gid": $WORK_GID,
    "workspace": "/srv/dyfj/work/$RUN-cli",
    "networkAllow": [
      "api.anthropic.com:443", "claude.ai:443", "console.anthropic.com:443",
      "auth.openai.com:443", "chatgpt.com:443"
    ]
  }
}
EOF
chmod 0644 /etc/dyfj/l8/profile.json
node /opt/dyfj/prototype/scripts/sandbox-install.ts --profile /etc/dyfj/l8/profile.json --out /etc/dyfj/l8 >/dev/null
chown -R root:root /etc/dyfj
chmod 0644 /etc/dyfj/l8/*.json

echo "== checks"
fail=0
check() { # description command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then echo "ok    $what"; else echo "FAIL  $what"; fail=1; fi
}
check "no Mac file sharing (/mnt/mac, /Users)" test ! -e /mnt/mac -a ! -e /Users
check "Mac-command integration is defunct" bash -c '! timeout 10 /opt/orbstack-guest/bin/mac true'
check "no forwarded SSH agent" bash -c '[[ -z ${SSH_AUTH_SOCK:-} ]] && ! ls /run/host-services/ssh-auth.sock'
check "Landlock ABI is at least 3" bash -c '[[ $(/usr/libexec/dyfj/dyfj-sandbox abi) -ge 3 ]]'
for user in dyfj-rt dyfj-ex dyfj-cli dyfj-db; do
  check "$user is in neither sudo nor orbstack" bash -c "! id -nG $user | grep -qwE 'sudo|orbstack|adm'"
  check "$user has no sudo rule" bash -c "sudo -l -U $user 2>&1 | grep -q 'is not allowed to run sudo'"
done
check "the launcher and plans are root-owned and not writable by others" bash -c \
  '[[ $(stat -c %U%a /usr/libexec/dyfj/dyfj-sandbox) == root755 ]] && ! find /etc/dyfj -perm /022 | grep -q .'
check "the REPL is root-owned and not writable by others" bash -c \
  '[[ $(stat -c %U%a /usr/libexec/dyfj/dyfj-repl) == root755 ]]'
check "the store's runtime password is readable by root only" bash -c \
  '[[ $(stat -c %U%a /etc/dyfj/dolt-runtime.password) == root600 ]]'
check "the store has the runtime's tables" bash -c \
  "cd /srv/dyfj/dolt && runuser -u dyfj-db -- env HOME=/srv/dyfj/dolt DOLT_CLI_PASSWORD= dolt --host 127.0.0.1 --port 3306 --no-tls --user root --use-db dolt sql -r csv -q 'show tables' | grep -qx sessions"
exit $fail
