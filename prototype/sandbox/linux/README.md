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

## Files

| File | Runs where | What it does |
|---|---|---|
| `provision.sh` | In the machine, as root | Pinned toolchain and launcher, the uids, the layout, an empty local Dolt store and the role plans, then checks that the Mac integrations are absent. |
| `../../scripts/sandbox-install.ts` | In the machine, as root | Derives the run envelope and the role policies from one composition, compiles each for this target, and writes the plans and a receipt to `/etc/dyfj/l8/`. |
| `core/dyfj-sandbox` | In the machine, as root | The launcher: installs a role's nftables rules, drops to its uid, starts bubblewrap, and applies Landlock inside it. |
| `acceptance.sh` | In the machine, as root | Design §8's Mac scenario, using synthetic canaries only. |
| `../../scripts/sandbox-export.ts` | On the Mac | Reads the workspace's commits as a bounded mbox. git runs in an executor sandbox. |

The operator's Mac-side scripts create the machine and deliver named
bootstrap secrets. They live with the operator's private tooling, not in this
repository.

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
- **Approval is unchanged.** The bash tool still asks as it does natively.
  Deciding approval from the boundary is separate work.
