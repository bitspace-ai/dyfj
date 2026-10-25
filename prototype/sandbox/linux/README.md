# The contained Linux target

An OrbStack isolated machine that runs Workbench roles below the product's
own code seams. The machine has no Mac file sharing, no SSH agent forwarding,
no Mac-command integration and no engine socket. Inside it, each role runs as
its own uid in a bubblewrap sandbox, under a Landlock floor and a per-uid
firewall that are compiled from the effective role policy. This is opt-in and
attended. Workbench's native runs on the Mac are unchanged and are not
contained by this.

## Roles

| Role | uid | Sandbox | Network | Holds |
|---|---|---|---|---|
| Runtime | `dyfj-rt` | Own user, PID, IPC, UTS, cgroup and mount namespaces. Landlock: direct execute only on its run grants, resolved to real paths at install, and the dynamic loader (execute scope `files`); toolchain and code read-only; workspace read-write. | Machine network. A per-uid nftables chain allows only the policy's resolved destinations, and rejects the rest (TCP with a reset). | Its bootstrap secrets, as files in `/secrets`. |
| Executor | `dyfj-ex` | Every namespace, the network included (`lo` only). Landlock: workspace read-write-execute; toolchain read-execute (execute scope `roots`: any program, by design). No nested user namespaces, no capabilities, no new privileges. | None. | Nothing. Only the bash tool's command environment. |
| CLI | `dyfj-cli` | Runtime-shaped sandbox with its own home and workspace (execute scope `roots`). | Its provider and login hosts only. | Its own model login. |
| Database | `dyfj-db` | systemd unit. | Loopback `127.0.0.1:3306`, reachable only by roles whose policy names it. | The machine's own Dolt store. |

`dyfj-sandbox serve` starts the runtime and answers the executor transport
(`DYFJ_EXECUTOR_SOCKET`) for the runtime's uid only. Each bash command and
each git operation runs in a fresh executor sandbox. When the runtime exits, the lease expires, and every
running executor is killed.

## Approval by the attested envelope

Before it serves, `serve` runs one probe in a fresh executor: a connect to a
TEST-NET-1 address, and a write beneath `/usr`. It logs whether the kernel
refused both, and how long the probe took. Before each bash or git call, the
runtime asks the supervisor to attest, and checks the answer
(`src/tools/builtin/containment.ts`):

- the runtime cannot write the socket's directory, so it cannot have bound
  the socket itself;
- the reply echoes a fresh nonce;
- the lease is live;
- the plan and policy files are as `serve` loaded them;
- the probe passed;
- the executor policy's digest verifies, and the policy has not expired;
- the policy has no network, broker operations, database or secrets, and no
  writable root over the whole filesystem or a forbidden path.

With all of these, and a grant for that policy's digest, a call on loopback
runs without a prompt, under `strict` and `operator` alike. Otherwise it asks.
The policy's verdict records why (an unattested containment and its reason,
no grant, or the supervisor's reason for refusing a grant), but the approval
prompt does not show it yet: run `approval-probe.sh attest` to see it.
Either way the command runs only in the executor. The read-only classifier is
not used on this route.

The grant is the operator's. Run as root:

```bash
node /opt/dyfj/prototype/scripts/sandbox-install.ts grant --dir /etc/dyfj/l8
```

It writes `/etc/dyfj/l8/envelope-grant.json`, naming the installed executor
policy's digest. `revoke --dir /etc/dyfj/l8` removes it. The supervisor reads
the grant at each attestation. It accepts the grant only when root owns the
file and its directory, and no one else can write either. A reinstall that
changes the policy leaves the grant naming the old digest, so it no longer
applies. Start the pair with the policy and the grant:

```bash
dyfj-sandbox serve --runtime-plan /etc/dyfj/l8/runtime.plan.json --executor-plan /etc/dyfj/l8/executor.plan.json --executor-policy /etc/dyfj/l8/executor.policy.json --grant /etc/dyfj/l8/envelope-grant.json --socket /run/dyfj-exec/exec.sock -- <runtime command>
```

A call the envelope allowed carries the supervisor instance that attested
it. The supervisor refuses a call bound to another instance.

The envelope does not cover:

- a deadline above the tool's default (120 s for bash);
- a tool with any other effect;
- a turn that is not on loopback.

Publishing stays outside it. The executor has no network, the git tool
refuses `push`, and patches leave through `sandbox-export.ts`.
`approval-probe.sh` exercises all of this with synthetic canaries.

## Files

| File | Runs where | What it does |
|---|---|---|
| `provision.sh` | In the machine, as root | Pinned toolchain and launcher, the uids, the layout, an empty local Dolt store and the role plans, then checks that the Mac integrations are absent. |
| `../../scripts/sandbox-install.ts` | In the machine, as root | Derives the run envelope and the role policies from one composition, compiles each for this target, and writes the plans and a receipt to `/etc/dyfj/l8/`. |
| `core/dyfj-sandbox` | In the machine, as root | The launcher: installs a role's nftables rules, drops to its uid, starts bubblewrap, and applies Landlock inside it. |
| `acceptance.sh` | In the machine, as root | Design §8's Mac scenario, using synthetic canaries only. It empties its run's workspace, so it refuses any run whose ID does not start with `uat-` or `acc-`, or whose workspace is not exactly `/srv/dyfj/work/<run>`: provision a throwaway run before running it. |
| `approval-probe.sh`, `approval-probe.ts` | In the machine, as root | Approval by the attested envelope: attestation, in-workspace shell syntax, escape attempts, session grants, and stale or forged attestations. Synthetic canaries only. |
| `../../scripts/sandbox-export.ts` | On the Mac | Reads a run's workspace commits as a bounded mbox, or counts its uncommitted paths (`status`). git runs in an executor sandbox. `--plans` names a work run's plan directory. |
| `l8-seed.sh` | In the machine, as root | Seeds a work run from a git bundle on stdin: its workspace, its own plans in `/etc/dyfj/l8/runs/<run>`, the clone (inside the run's executor), and its npm packages. |
| `l8-work.sh` | In the machine, as root | One attended work session: the session lock, the grant state, the attested pair, and the REPL in the operator's terminal; then cleanup. `stop` ends a session whose terminal went away. |
| `../../scripts/sandbox-runtime.ts` | In the machine, in the runtime role | The runtime's entry point there: reads the delivered secret files into the runtime's environment, then runs the server. |
| `work-probe.ts` | In the machine | A scripted client that stands in for the REPL (`l8-work.sh --probe`), with no model call. |

The operator's Mac-side scripts create the machine and deliver named
bootstrap secrets. They live with the operator's private tooling, not in this
repository.

## Work sessions

The operator's `dyfj-l8 work` seeds a fresh run from a Mac branch and
attaches the Workbench REPL to that run's runtime. `dyfj-l8 export` turns
the run's new commits into a Mac branch. Both commands live with the
operator's private tooling. In the machine:

- **Each work run has its own plans.** `l8-seed.sh` installs them in
  `/etc/dyfj/l8/runs/<run>`, from the provisioned profile with this run's
  name and workspace. A new run therefore has a new executor policy digest,
  and a grant applies to one run only. The provisioned run's plans in
  `/etc/dyfj/l8` are not rewritten.
- **The workspace is cloned inside the run's executor**, from a git bundle
  on stdin, with group-writable files so the runtime's file tools can edit
  them. When the branch has a root `package-lock.json`, root installs its
  packages with `npm ci --ignore-scripts` from a copy of the manifests only,
  because the executor has no network.
- **One session at a time.** Every run's runtime shares the runtime uid's
  firewall table and the executor socket, so `l8-work.sh` takes a lock.
- **The REPL runs as `dyfj-rt` outside bubblewrap**, with no new privileges
  and a cleared environment, connected to the runtime's socket in its home
  (`/srv/dyfj/state/runtime/.dyfj/run/workbench.sock`). The runtime uid's
  firewall table applies to it. It can read what that uid can read on the
  machine: the runtime's delivered secrets, its home, and every workspace
  through the shared group. It runs no tools; those go through the runtime
  to the executor.
- **Secrets last one session.** The runtime reads the files the broker
  delivered for the secret variables it may take (`sandbox-runtime.ts`), and
  `l8-work.sh` removes each file of those names when the session ends. Other
  files in the secrets directory are left alone. The local store's runtime password is made at
  provisioning, kept in a root-only file, and copied for the session only.
- **The local store** gets the canonical schema when its `dolt` database
  does not exist, and a `dyfj_runtime` user with the grants
  `schema/README.md` lists. It holds no memories and no operator context. An
  existing database is not migrated: a newer schema needs a new store.

## Running the CLIs

From the Mac, start an agent CLI in the CLI role. It runs in its own
workspace (`/work`), with its own home (`/home`):

```bash
orb -m dyfj-l8 -u root env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home TERM="$TERM" LANG=C.UTF-8 /usr/libexec/dyfj/dyfj-sandbox run --plan /etc/dyfj/l8/cli.plan.json -- claude
```

Start Codex with `--no-daemon`, which goes before any subcommand:

```bash
orb -m dyfj-l8 -u root env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home TERM="$TERM" LANG=C.UTF-8 /usr/libexec/dyfj/dyfj-sandbox run --plan /etc/dyfj/l8/cli.plan.json -- codex --no-daemon
```

Without that flag, Codex downloads a managed binary into
`~/.codex/packages/` and tries to run it. The CLI's home is writable but not
executable, so the kernel refuses with `EACCES` ("Permission denied (os
error 13)"). That refusal is intended: a role may not run what it downloads
into its home. With `--no-daemon`, Codex runs the npm-installed binary under
`/usr/local`, which the role may execute. Do not make the home executable to
avoid the flag.

## What it does not contain

- **One kernel.** Every OrbStack machine and container shares one Linux VM
  kernel. A kernel exploit is not contained. Deliberately hostile code does
  not belong here.
- **Hostname assurance is `address-set`, not `tls`.** The firewall filters a
  provider by the addresses its name resolved to when the plans were
  installed. Any other host at those addresses (a CDN's neighbours) is
  reachable as well. This weaker enforcement is opted into twice: the target
  declares it, and the machine profile names each accepted entry. It is
  recorded as `enforcedAssurance` on every compiled entry and in the receipt.
  An SNI-checking gateway would remove the downgrade; that is not built yet.
- **The CLI's shell.** Claude Code and Codex run their own shell inside the
  CLI role, as `dyfj-cli`, next to their model login. Routing their shells
  into the executor is not done.
- **The CLI's model login.** A login made inside the machine stays in
  `dyfj-cli`'s home. The executor cannot read it, but the CLI's own commands
  can.
- **Only the runtime's executable list is enforced.** The executor and the
  CLIs run arbitrary programs as their job, so they execute from their roots
  whole. The plan and the receipt record this as execute scope `roots`.
- **The execute floor covers direct execution only.** Landlock's execute
  right governs `execve`. The dynamic loader (`ld-linux`) and the
  interpreters are allowed toolchain files, and they map or read the program
  they are given. So a role can still run a binary or script it can read,
  from the workspace or scratch, through the loader or an interpreter. The
  acceptance run records whether loader-mediated execution succeeds. On
  2026-10-22 it did: direct execution of a workspace binary was refused with
  `EACCES`, and the same binary run through `ld-linux-aarch64.so.1`
  succeeded. The floor stops a stray `execve` of a
  dropped file, not arbitrary computation.
- **The work REPL is not sandboxed.** It runs as the runtime's uid with that
  uid's read access to the machine; see Work sessions.
- **The runtime's own secrets.** A compromised runtime dependency can use the
  runtime's secrets and reach its allowed destinations. The boundary stops it
  from reaching anything else.
- **Workspace git metadata is writable.** Landlock only grants access, so
  `.git/hooks` and `.git/config` beneath a writable workspace cannot be
  protected. The launch plan refuses a policy that asks for that protection;
  it does not drop it silently. Nothing outside the executor runs git where
  the executor writes:
  - the runtime's `git` and `bash` tools run in the executor;
  - the export runs there too, with hooks, fsmonitor, external diff, textconv,
    pager and system config all off;
  - the CLI has a workspace of its own.

  So a planted hook runs only in the executor. The acceptance run plants a
  hook and an fsmonitor to show this.
- **The attestation proves configuration and one probe, not the kernel.**
  It shows which policy the supervisor loaded, and that one connect and one
  write were refused when the pair started. It cannot show that the shared
  kernel has no exploitable bug. The runtime's check that it did not bind
  the socket itself rests on file modes, because Node exposes no peer
  credential.
