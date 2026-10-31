/**
 * One publish run's phases (BIT-786): the pre-gate, then the gate.
 *
 * Three properties this module exists to hold:
 *
 * - **The pins are re-read, never assumed.** Before each phase, before a pass
 *   is recorded, and after the gate exits - before the ticket is marked ready -
 *   the layout is read again host-side and compared with the ticket's. A
 *   different git dir, commondir, branch or commit fails the ticket and starts
 *   nothing more: a gate that ran against one commit must not vouch for
 *   another. (The push, in the next slice, re-checks the commit again.)
 * - **The detached run has no unhandled rejection path.** Substitution, a
 *   command that cannot start and a command handle that rejects are each
 *   turned into the ticket's `failed` phase; a report that cannot be written
 *   is recorded on the ticket beside its verdict; and
 *   `publish/start` calls `runGates` without awaiting it but with a handler
 *   attached anyway, so even a defect here is reported rather than dropped.
 * - **A dead ticket starts nothing.** The ticket is consulted after every
 *   await and immediately before every start, so a cancel, an expiry or a
 *   failure during a phase stops the run rather than letting it begin the
 *   next one for a ticket nobody can approve.
 *
 * The report is opened exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600) in a
 * directory that must be the runtime's own, must resolve to itself, and must be
 * outside everything the session's sandbox can write. The directory checks and
 * the open are separate path lookups; the sandbox check is what keeps a
 * sandboxed command from swapping an ancestor between them. The file holds
 * each phase's bounded, decoded output under a header naming the phase; it is
 * not filtered.
 */

import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import {
  fillPublishArgv,
  MAX_ELEMENT_BYTES,
  type PublishConfig,
  type PublishValues,
} from "../../config/publish-config.ts";
import type { Env } from "../../config/mod.ts";
import type { RuntimePolicy } from "../../config/runtime-policy.ts";
import { clipToUtf8Bytes, pathFreeReason } from "../../kernel/mod.ts";
import {
  type GitLayout,
  layoutsMatch,
  publishChildEnv,
  publishGitEnvFor,
  readPublishGitLayout,
} from "./publish-git.ts";
import {
  PUBLISH_OUTPUT_CAP_BYTES,
  type PublishCommandResult,
  publishPolicyFor,
  startPublishCommand,
} from "./publish-run.ts";
import type {
  PublishPhase,
  PublishTicketView,
  PublishTickets,
} from "./publish-tickets.ts";
import { compileWorkspacePolicy } from "./srt-policy.ts";
import { SRT_SCRATCH_DIR } from "./srt-sandbox.ts";

/** Lines of a stopped phase quoted back, and the bytes each may carry. */
export const FINDING_LINES = 10;
export const FINDING_LINE_MAX = 300;

/** The phase a run is in, as the runner names it. */
export type PublishPhaseName = "pre-gate" | "gate";

/** What the runner needs of the report: append, and whether a write failed. */
export interface PublishReportSink {
  append(phase: string, result: PublishCommandResult): Promise<void>;
  readonly writeError: string | undefined;
}

/** What the runner needs from the tool definition. */
export interface PublishPhaseDeps {
  config: PublishConfig;
  tickets: PublishTickets;
  policy: RuntimePolicy;
  sessionId: string;
  readLayout?: (root: string) => Promise<GitLayout>;
  startCommand?: typeof startPublishCommand;
  /** The child environment's source; the process environment when absent. */
  childEnv?: Env;
}

/**
 * An exception's message with host paths removed, for a reason a model and the
 * durable log both read. A spawn error names the command and, for a command
 * outside the run policy, the path it resolved to; a gate's failure is about
 * the phase, not about where the runtime keeps things. One implementation, in
 * the kernel (`pathFreeReason`), shared with the precheck a command may define.
 */
export { pathFreeReason };

/**
 * The report's findings: the first non-empty lines of the output the run kept,
 * each byte-capped. The kept window is the LAST `PUBLISH_OUTPUT_CAP_BYTES` of a
 * chatty run, so these are the first lines of that window; `truncated` says
 * earlier output was dropped.
 */
export function findingLines(output: string, truncated: boolean): string {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const head = lines.slice(0, FINDING_LINES).map((line) => {
    const clipped = clipToUtf8Bytes(line, FINDING_LINE_MAX);
    return clipped === null ? line : `${clipped}…`;
  });
  const dropped = lines.length > FINDING_LINES;
  const notes: string[] = [];
  if (truncated) {
    notes.push(`(earlier output dropped above ${PUBLISH_OUTPUT_CAP_BYTES} bytes)`);
  }
  if (dropped) notes.push(`(further lines not shown)`);
  return [...notes, ...head].join("\n");
}

/** Why a finished phase stopped the run, as one operator-facing line. */
export function failureReason(
  phase: PublishPhaseName,
  result: PublishCommandResult,
): string {
  const survivors = result.pipesLeftOpen
    ? "; a process that left its group may still be running"
    : "";
  if (result.cancelled) return `the ${phase} was cancelled${survivors}`;
  if (result.timedOut) {
    return `the ${phase} hit its deadline and was stopped${survivors}`;
  }
  return `the ${phase} exited ${
    result.code === null ? "by signal" : String(result.code)
  }`;
}

/**
 * The run's report file, opened exclusively. The file is 0600 and never
 * follows a symlink, and a path already occupied is refused: one run's report
 * must not be appended to another's, and a planted symlink must not redirect
 * the write.
 *
 * The directory is the part a planted path could aim: the operator configures
 * `report_path`, but its parent may be somewhere a sandboxed command can write.
 * A directory created here gets 0700; one that already exists must be the
 * runtime's own uid with no group or other bits, and its realpath must be the
 * path itself, so no symlinked ancestor decides where the report lands.
 */
async function openReport(
  path: string,
  writableBySandbox: (directory: string) => Promise<boolean>,
): Promise<FileHandle> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertReportDirectory(directory);
  if (await writableBySandbox(directory)) {
    throw new Error(
      "the report directory is writable from the sandbox; a sandboxed command " +
        "could redirect the report",
    );
  }
  return await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW |
      constants.O_WRONLY | constants.O_APPEND,
    0o600,
  );
}

/** The report directory is the runtime's own, and is where it claims to be. */
async function assertReportDirectory(directory: string): Promise<void> {
  // First: is this path the directory it names, or something that resolves to
  // one elsewhere? lstat also catches a symlink standing where the directory
  // should be, before any of its bits are read.
  const real = await realpath(directory);
  if (real !== directory) {
    throw new Error(
      "the report directory resolves through a symlink to another path",
    );
  }
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) {
    throw new Error("the report directory is not a directory");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && info.uid !== BigInt(uid)) {
    throw new Error("the report directory is not owned by the runtime's uid");
  }
  // Group or other write would let another local user plant the file first;
  // any group or other bit at all is more than a report directory needs.
  if ((info.mode & 0o077n) !== 0n) {
    throw new Error(
      "the report directory is readable or writable beyond its owner",
    );
  }
}

/** Written through the exclusive handle; a failure to write is remembered. */
export class PublishReport {
  readonly #path: string;
  readonly #writableBySandbox: (directory: string) => Promise<boolean>;
  #handle: FileHandle | undefined;
  #error: string | undefined;

  /**
   * `writableBySandbox` answers whether the session's sandbox could write a
   * directory; `sandboxWriteCheck` builds it from the ticket's layout.
   */
  constructor(
    path: string,
    options: { writableBySandbox: (directory: string) => Promise<boolean> },
  ) {
    this.#path = path;
    this.#writableBySandbox = options.writableBySandbox;
  }

  /** Open (or reuse) the handle. Rejects when the path is occupied. */
  async start(): Promise<void> {
    if (this.#handle !== undefined) return;
    this.#handle = await openReport(this.#path, this.#writableBySandbox);
  }

  get writeError(): string | undefined {
    return this.#error;
  }

  /** Append one phase's output. A write failure is recorded, never thrown. */
  async append(phase: string, result: PublishCommandResult): Promise<void> {
    const status = result.cancelled
      ? "cancelled"
      : result.timedOut
      ? "timed out"
      : `exit ${result.code === null ? "by signal" : String(result.code)}`;
    try {
      await this.start();
      const dropped = result.truncated
        ? `(earlier output dropped above ${PUBLISH_OUTPUT_CAP_BYTES} bytes)\n`
        : "";
      const survivors = result.pipesLeftOpen
        ? "(its output pipes were still open after the stop; a process that " +
          "left its group may still be running)\n"
        : "";
      await this.#handle?.appendFile(
        `== ${phase}: ${status} ==\n${dropped}${survivors}${result.output}\n`,
        "utf8",
      );
    } catch (error) {
      // The phase's verdict stands; `status` reports that the report is short.
      this.#error ??= (error as Error).message;
    }
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => {});
  }
}

/**
 * Whether the session's sandbox could write `directory`: covered by a write
 * grant the session's policy compiles (and not by a deny), or inside srt's own
 * scratch directory. Paths are compared as realpaths.
 */
export function sandboxWriteCheck(
  layout: GitLayout,
): (directory: string) => Promise<boolean> {
  // The realpath of the nearest existing ancestor, with the rest appended: a
  // report directory may not exist yet, and macOS bridges /tmp to /private/tmp.
  const canonical = (path: string): string => {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      const parent = dirname(absolute);
      if (parent === absolute) return absolute;
      return `${canonical(parent).replace(/\/$/u, "")}/${basename(absolute)}`;
    }
  };
  const covers = (entry: string, path: string): boolean =>
    path === entry || path.startsWith(`${entry}/`);
  return async (directory) => {
    const policy = await compileWorkspacePolicy(layout.topLevel, {
      pinnedLayout: {
        gitDir: layout.gitDir,
        commonDir: layout.commonDir,
        topLevel: layout.topLevel,
        branchRef: layout.branchRef,
      },
    });
    const target = canonical(directory);
    if (policy.filesystem.denyWrite.map(canonical).some((e) => covers(e, target))) {
      return false;
    }
    return [...policy.filesystem.allowWrite, SRT_SCRATCH_DIR]
      .map(canonical)
      .some((entry) => covers(entry, target));
  };
}

/** The placeholder values one phase's argv is filled from. */
function valuesFor(
  view: PublishTicketView,
  issue: string | undefined,
  implementer: string,
): PublishValues {
  return {
    repo: view.repository,
    branch: view.branch ?? "",
    head: view.head ?? "",
    range: "origin/main...HEAD",
    issue: issue ?? "",
    implementer,
    report: view.reportPath,
    ticket: view.ticket,
  };
}

/**
 * Re-read the pins and compare them with the ticket's. Returns the live layout
 * when they still match, or the reason the phase must not start. Read
 * host-side, from the root the ticket pinned.
 */
async function recheckPins(
  readLayout: (root: string) => Promise<GitLayout>,
  created: PublishTicketView,
  what: string,
): Promise<{ layout: GitLayout } | { reason: string }> {
  let live: GitLayout;
  try {
    live = await readLayout(created.repository);
  } catch (error) {
    return {
      reason: `${what}: the layout could not be re-read (${
        pathFreeReason(error)
      })`,
    };
  }
  if (!layoutsMatch(live, created.layout)) {
    return {
      reason: `${what}: the repository, branch or commit changed since the ` +
        `ticket was created`,
    };
  }
  return { layout: live };
}

/** The argv one phase starts with, bounded again on what is actually started. */
function phaseArgv(
  template: readonly string[],
  values: PublishValues,
  what: string,
): { argv: string[] } | { reason: string } {
  try {
    return {
      argv: fillPublishArgv(template, values).map((element) => {
        if (Buffer.byteLength(element, "utf8") > MAX_ELEMENT_BYTES) {
          throw new Error(
            `a substituted value exceeds ${MAX_ELEMENT_BYTES} bytes`,
          );
        }
        return element;
      }),
    };
  } catch (error) {
    return { reason: `${what}: ${pathFreeReason(error)}` };
  }
}

/**
 * Run the pre-gate, then the gate. Every phase failure this module can
 * anticipate becomes the ticket's `failed` phase, which `status` reports, and a
 * report that cannot be written is noted on the ticket; it does not reject for
 * those. The caller still attaches a handler (`publish/start` does),
 * because a defect inside here must never surface as an unhandled rejection in
 * the runtime - that guard is the caller's, not this function's promise.
 */
export async function runGates(
  deps: PublishPhaseDeps,
  created: PublishTicketView,
  issue: string | undefined,
  implementer: string,
  report: PublishReportSink,
): Promise<void> {
  const readLayout = deps.readLayout ?? readPublishGitLayout;
  const startCommand = deps.startCommand ?? startPublishCommand;
  // The operator's own binaries are the only grant added, and it comes from
  // config rather than from any model-supplied value.
  const policy = publishPolicyFor(deps.policy, deps.config);
  const env = {
    ...publishChildEnv(deps.childEnv),
    ...publishGitEnvFor(created.layout),
  };
  const values = valuesFor(created, issue, implementer);
  const phases: readonly (readonly [PublishPhaseName, readonly string[]])[] = [
    ["pre-gate", deps.config.preGate],
    ["gate", deps.config.gate],
  ];

  /** Fail the ticket once, with the head of whatever output the phase kept. */
  const fail = (
    phase: PublishPhaseName,
    reason: string,
    result?: PublishCommandResult,
  ): void => {
    deps.tickets.markFailed(
      deps.sessionId,
      created.ticket,
      phase,
      report.writeError === undefined
        ? reason
        : `${reason} (the report could not be written: ${report.writeError})`,
      result === undefined ? "" : findingLines(result.output, result.truncated),
      result?.truncated ?? false,
      report.writeError,
    );
  };

  /**
   * The ticket this run belongs to, or null once it is gone (swept, or created
   * by another run). Read after every await and before every start.
   */
  const stillLive = (): boolean =>
    deps.tickets.get(deps.sessionId, created.ticket) !== null;

  /**
   * The phase the ticket must be in for `phase` to start. A cancelled or
   * expired ticket is RETAINED (its phase is `failed` or `expired`), so mere
   * existence proves nothing: a cancel during a layout read would otherwise
   * still reach `startCommand`.
   */
  const activePhase = (phase: PublishPhaseName): PublishPhase =>
    phase === "pre-gate" ? "pre-gate" : "gated";

  /** True when the ticket is still in the phase that is about to start. */
  const stillActiveFor = (phase: PublishPhaseName): boolean =>
    deps.tickets.get(deps.sessionId, created.ticket)?.phase ===
      activePhase(phase);

  for (const [phase, template] of phases) {
    if (!stillLive()) return;
    // The pins first: a head that moved under a running gate makes this phase
    // meaningless, whoever moved it.
    const pinned = await recheckPins(
      readLayout,
      created,
      `the ${phase} did not start`,
    );
    if (!("layout" in pinned)) {
      fail(phase, pinned.reason);
      return;
    }
    if (!stillLive()) return;

    const built = phaseArgv(
      template,
      values,
      `the ${phase} did not start`,
    );
    if (!("argv" in built)) {
      fail(phase, built.reason);
      return;
    }
    const { argv } = built;

    // The last check before a process exists: the ticket must still be in the
    // phase about to start, not merely present.
    if (!stillActiveFor(phase)) return;
    let result: PublishCommandResult;
    try {
      const handle = startCommand(
        {
          argv,
          cwd: created.repository,
          env,
          timeoutMs: deps.config.gateTimeoutMs,
        },
        policy,
      );
      if (
        !deps.tickets.attachCancelHook(deps.sessionId, created.ticket, () =>
          handle.cancel()
        )
      ) {
        // The ticket left its active phase between the check above and the
        // hook: the process exists but nothing can approve it, so stop it.
        handle.cancel();
      }
      result = await handle.result;
    } catch (error) {
      // A command that cannot start, or a handle that rejects: both are the
      // phase's failure, reported the same way as a non-zero exit.
      fail(phase, `the ${phase} could not run: ${pathFreeReason(error)}`);
      return;
    }

    await report.append(phase, result);
    // A cancelled, expired or failed ticket must not start the next phase.
    if (!stillLive()) return;
    if (result.code !== 0 || result.timedOut || result.cancelled) {
      fail(phase, failureReason(phase, result), result);
      return;
    }
    if (phase === "pre-gate") {
      // Re-reading before the pass is recorded: the gate is about to run, and
      // it must run against the commit this ticket pins.
      let after: GitLayout;
      try {
        after = await readLayout(created.repository);
      } catch (error) {
        fail(
          phase,
          `the gate did not start: the layout could not be re-read (${
            pathFreeReason(error)
          })`,
        );
        return;
      }
      if (!stillLive()) return;
      if (!layoutsMatch(after, created.layout)) {
        fail(
          phase,
          "the gate did not start: the repository, branch or commit changed " +
            "since the ticket was created",
        );
        return;
      }
      if (deps.tickets.markGated(deps.sessionId, created.ticket) === null) {
        // Cancelled or expired while the pre-gate ran: nothing more starts.
        return;
      }
      continue;
    }
    // The last chance for the pins: a head that moved while the gate ran makes
    // its verdict about a commit this ticket does not pin.
    let settled: GitLayout;
    try {
      settled = await readLayout(created.repository);
    } catch (error) {
      fail(
        phase,
        `the run did not finish: the layout could not be re-read (${
          pathFreeReason(error)
        })`,
        result,
      );
      return;
    }
    if (!stillLive()) return;
    if (!layoutsMatch(settled, created.layout)) {
      fail(
        phase,
        "the run did not finish: the repository, branch or commit changed " +
          "while the gate ran",
        result,
      );
      return;
    }
    const ready = deps.tickets.markReady(
      deps.sessionId,
      created.ticket,
    );
    if (ready !== null && report.writeError !== undefined) {
      // Both phases passed, so this is not a failure - but the report is the
      // operator's evidence, and a run without one must not look complete.
      deps.tickets.noteReportError(
        deps.sessionId,
        created.ticket,
        report.writeError,
      );
    }
  }
}
