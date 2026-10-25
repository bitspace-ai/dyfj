#!/usr/bin/env bash
# Seed a fresh work run in the isolated machine from a git bundle on stdin
# (BIT-779). Run as root inside the machine, by the operator's `dyfj-l8 work`:
#
#   bash l8-seed.sh <run> <branch> <repository> <git-name> <git-email> < repo.bundle
#
# <repository> is `owner/name` for the run's identity. The script:
#
#   1. creates the run's workspace (/srv/dyfj/work/<run>, the executor's) and
#      the CLI workspace the installer requires apart from it;
#   2. writes the run's profile, from the provisioned one with this run's
#      name, workspaces and repository, and installs its plans into
#      /etc/dyfj/l8/runs/<run> with sandbox-install.ts; no grant is written;
#   3. clones the bundle's <branch> into the workspace inside a fresh executor
#      sandbox of this run, as the executor's uid, with group-writable files
#      so the runtime's file tools can edit them, hooks and system config off,
#      and git's identity set from <git-name> and <git-email>;
#   4. when the branch has a package-lock.json at its root, installs its
#      packages as root with `npm ci --ignore-scripts`, from a copy of the
#      lockfile and the package.json files only, and moves each node_modules
#      into the workspace, owned by the executor. The executor has no network,
#      so this is the only way a seeded tree gets its packages.
#
# It prints the executor policy's digest, which a grant must name. It refuses
# a run that exists, and run-0001. Nothing here reads a secret.
set -euo pipefail

SANDBOX=/usr/libexec/dyfj/dyfj-sandbox
INSTALL=/opt/dyfj/prototype/scripts/sandbox-install.ts

[[ $(id -u) -eq 0 ]] || { echo "l8-seed.sh must run as root" >&2; exit 2; }
[[ $# -eq 5 ]] || { echo "usage: l8-seed.sh <run> <branch> <repository> <git-name> <git-email> < bundle" >&2; exit 2; }
RUN=$1 BRANCH=$2 REPOSITORY=$3 GIT_NAME=$4 GIT_EMAIL=$5
[[ $RUN =~ ^[a-z0-9][a-z0-9-]{0,62}$ && $RUN != run-0001* ]] || { echo "run id must be a short lowercase name, not run-0001" >&2; exit 2; }
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || { echo "not a branch name: $BRANCH" >&2; exit 2; }
[[ $REPOSITORY =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "repository must be owner/name" >&2; exit 2; }
for value in "$GIT_NAME" "$GIT_EMAIL"; do
  [[ -n $value && $value != *[[:cntrl:]]* && ${#value} -le 200 ]] || { echo "git identity values must be short printable text" >&2; exit 2; }
done

WORK=/srv/dyfj/work/$RUN
PLANS=/etc/dyfj/l8/runs/$RUN
for path in "$WORK" "$WORK-cli" "$PLANS"; do
  [[ ! -e $path ]] || { echo "$path exists; a run is seeded once" >&2; exit 1; }
done

stage=$(mktemp -d /var/tmp/dyfj-l8-seed.XXXXXX)
trap 'rm -rf "$stage"' EXIT
chmod 0700 "$stage"
cat >"$stage/seed.bundle"
git bundle verify -q "$stage/seed.bundle" >/dev/null 2>&1 || { echo "stdin is not a complete git bundle" >&2; exit 1; }

echo "== workspace and plans for $RUN"
install -d -o dyfj-ex -g dyfj-work -m 2770 "$WORK"
install -d -o dyfj-cli -g dyfj-work -m 2770 "$WORK-cli"
install -d -o root -g root -m 0755 /etc/dyfj/l8/runs "$PLANS"
node -e '
  const fs = require("fs");
  const [template, out, run, repository] = process.argv.slice(1);
  const profile = JSON.parse(fs.readFileSync(template, "utf8"));
  profile.identity.run = run;
  profile.identity.repositories = [repository];
  profile.identity.expiresAt = new Date(Date.now() + 30 * 864e5).toISOString().replace(/\.\d+Z$/, "Z");
  profile.workspace = `/srv/dyfj/work/${run}`;
  profile.cli.workspace = `/srv/dyfj/work/${run}-cli`;
  fs.writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", { mode: 0o644 });
' /etc/dyfj/l8/profile.json "$PLANS/profile.json" "$RUN" "$REPOSITORY"
node "$INSTALL" --profile "$PLANS/profile.json" --out "$PLANS" >/dev/null
chown -R root:root "$PLANS"
chmod 0644 "$PLANS"/*.json

echo "== clone $BRANCH in the executor"
# The bundle sits in the workspace only while the executor fetches from it.
install -o dyfj-ex -g dyfj-work -m 0440 "$stage/seed.bundle" "$WORK/.dyfj-seed.bundle"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp GIT_CONFIG_NOSYSTEM=1 \
  "$SANDBOX" run --plan "$PLANS/executor.plan.json" --cwd /work -- \
  /usr/bin/sh -c 'umask 002 &&
    git -c core.hooksPath=/dev/null init -q &&
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch -q ./.dyfj-seed.bundle "refs/heads/$1:refs/heads/$1" &&
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false checkout -q "$1" &&
    git config core.sharedRepository group &&
    git config user.name "$2" &&
    git config user.email "$3" &&
    rm -f ./.dyfj-seed.bundle &&
    git rev-parse HEAD' sh "$BRANCH" "$GIT_NAME" "$GIT_EMAIL" | sed 's/^/seeded at /'

if [[ -f $WORK/package-lock.json ]]; then
  echo "== packages (npm ci --ignore-scripts, from the lockfile)"
  npm_stage=$stage/npm
  mkdir -p "$npm_stage"
  (cd "$WORK" && find . -name node_modules -prune -o -name .git -prune -o \
    \( -name package.json -o -path ./package-lock.json \) -type f -print0) |
    while IFS= read -r -d '' file; do
      install -D -m 0644 "$WORK/$file" "$npm_stage/$file"
    done
  (cd "$npm_stage" && npm ci --ignore-scripts --no-fund --no-audit >/dev/null)
  (cd "$npm_stage" && find . -name node_modules -prune -type d -print0) |
    while IFS= read -r -d '' dir; do
      rm -rf "${WORK:?}/$dir"
      mv "$npm_stage/$dir" "$WORK/$dir"
      chown -R dyfj-ex:dyfj-work "$WORK/$dir"
    done
  echo "installed packages"
fi

node -e 'console.log("executor policy " + JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).identity.digest)' "$PLANS/executor.policy.json"
