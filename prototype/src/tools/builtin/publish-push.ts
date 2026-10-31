/**
 * The last two publish phases (BIT-830): the push, then the pull request.
 *
 * The gates leave a ticket in `ready`; this module ships it. Three properties:
 *
 * - **The pin is checked once, before the push.** A ticket is pushed at most
 *   once, so the commit is re-read and compared with the ticket's before the
 *   push starts, and `markPushing` refuses a head that differs from the pin.
 *   `open_pr` is not re-checked: the push already happened, and the commit that
 *   is now published is the one the ticket pins.
 * - **A failed push is final, a failed pull request is not.** Pushing stopped
 *   the run, so the ticket goes `failed` with `failedPhase: "push"`. A pull
 *   request that failed leaves the ticket `pushed`: the commits are published,
 *   and a second call retries only that step rather than pushing twice.
 * - **A command's failure is the ticket's, a refusal is an exception.** A
 *   command that cannot start, a non-zero exit, a deadline and a cancel are
 *   each recorded on the ticket with the head of the output kept. The refusals
 *   that start nothing - an unknown ticket, a ticket in the wrong phase, no
 *   configured commands, pins that no longer match or cannot be read, a pull
 *   request another call is already opening - throw and leave the ticket as
 *   it was.
 *
 * This module registers no tool: a later slice wraps `runPush` in
 * `publish/push`, and the approval that binds the commit belongs there.
 */

import { CommandExecutionError } from "../definition.ts";
import {
  publishChildEnv,
  publishGitEnvFor,
  readPublishGitLayout,
} from "./publish-git.ts";
import {
  failureReason,
  findingLines,
  pathFreeReason,
  phaseArgv,
  type PublishPhaseDeps,
  recheckPins,
  valuesFor,
} from "./publish-phase.ts";
import {
  publishPolicyFor,
  type PublishCommandResult,
  startPublishCommand,
} from "./publish-run.ts";
import type { PublishTicketView } from "./publish-tickets.ts";

/** A push is minutes, not the gates' half hour; past this it is stopped. */
export const PUSH_TIMEOUT_MS = 120_000;

/**
 * A pull request URL, as `gh` prints one (`https://<host>/<owner>/<repo>/pull/<n>`):
 * the only thing taken from output.
 */
const PR_URL =
  /^https:\/\/[^\s/]{1,253}\/[^\s/]{1,100}\/[^\s/]{1,100}\/pull\/[1-9][0-9]{0,9}$/u;

/**
 * What a phase that stopped leaves on the ticket: the reason, and the head of
 * whatever output it kept. A phase that never started kept nothing.
 */
interface PhaseStop {
  reason: string;
  result?: PublishCommandResult;
}

/** True when a finished command stopped its phase. */
function stopped(result: PublishCommandResult): boolean {
  return result.code !== 0 || result.timedOut || result.cancelled;
}

/** The findings one stop reports: the first non-empty lines it kept. */
function findings(stop: PhaseStop): { head: string; truncated: boolean } {
  const result = stop.result;
  if (result === undefined) return { head: "", truncated: false };
  return {
    head: findingLines(result.output, result.truncated),
    truncated: result.truncated,
  };
}

/** The last trimmed line of `open_pr`'s output that matches `PR_URL`. */
function prUrlIn(output: string): string | undefined {
  const lines = output.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && PR_URL.test(line)) return line;
  }
  return undefined;
}

/**
 * Run the push and then the pull request for one ticket, and return the
 * ticket's final view.
 *
 * Synchronous from the caller's view: it awaits both commands. The caller
 * bounds its own turn; a push is short, and the pull request is shorter.
 */
export async function runPush(
  deps: PublishPhaseDeps,
  ticket: string,
): Promise<PublishTicketView> {
  const { config, tickets, sessionId } = deps;
  const startCommand = deps.startCommand ?? startPublishCommand;
  const readLayout = deps.readLayout ?? readPublishGitLayout;

  const current = (): PublishTicketView => {
    const view = tickets.get(sessionId, ticket);
    if (view === null) {
      throw new CommandExecutionError(
        "this runtime holds no such publish ticket; a ticket does not survive " +
          "a restart",
      );
    }
    return view;
  };

  const view = current();
  // Both phases this module runs, so both commands must exist. A push with no
  // pull request would leave a published branch nobody opened a review for.
  if (config.push === undefined || config.openPr === undefined) {
    throw new CommandExecutionError(
      "this run has no push or open_pr command configured, so there is " +
        "nothing to ship; configure both in [publish] or start a new run",
    );
  }
  if (view.phase !== "ready" && view.phase !== "pushed") {
    throw new CommandExecutionError(
      `ticket ${view.ticket} is in phase ${view.phase}; only a ticket in ` +
        `ready or pushed can be pushed or have its pull request opened`,
    );
  }
  // The same environment `runGates` builds: the caller's, with the git
  // hardening that pins the child to this worktree.
  const env = {
    ...publishChildEnv(deps.childEnv),
    ...publishGitEnvFor(view.layout),
  };
  const policy = publishPolicyFor(deps.policy, config);
  // `{implementer}` names the models that wrote the code, which a push does
  // not have: the gates are where a reviewer is chosen.
  const values = valuesFor(view, view.trackerIssue, "");

  /** Start one phase's argv and wait for it; every stop becomes a reason. */
  const runPhase = async (
    template: readonly string[],
    what: string,
  ): Promise<{ result: PublishCommandResult } | PhaseStop> => {
    const built = phaseArgv(template, values, what);
    if (!("argv" in built)) return { reason: built.reason };
    try {
      const handle = startCommand(
        {
          argv: built.argv,
          cwd: view.repository,
          env,
          timeoutMs: PUSH_TIMEOUT_MS,
        },
        policy,
      );
      const result = await handle.result;
      if (stopped(result)) {
        return { reason: failureReason(what, result), result };
      }
      return { result };
    } catch (error) {
      // A command that cannot start, or a handle that rejects: both are the
      // phase's failure, reported the same way as a non-zero exit.
      return { reason: `the ${what} could not run: ${pathFreeReason(error)}` };
    }
  };

  let live = view;
  if (live.phase === "ready") {
    // The pins first: a head that moved since the gate passed makes the
    // approval describe a commit nobody gated.
    const pinned = await recheckPins(readLayout, live, "the push did not start");
    if (!("layout" in pinned)) {
      throw new CommandExecutionError(pinned.reason);
    }
    // The pins matched, so the live head is the ticket's own; a ticket created
    // on an unborn branch has none, and `markPushing` refuses that rather than
    // pushing something it cannot name.
    const pushing = tickets.markPushing(
      sessionId,
      live.ticket,
      pinned.layout.head ?? "",
    );
    if (pushing === null) {
      // The ticket left `ready` while the pins were being read: a cancel, a
      // denial or an expiry. Nothing starts, and its own view is what to read.
      return current();
    }
    if (pushing.phase !== "pushing") return pushing;
    live = pushing;

    const pushed = await runPhase(config.push, "push");
    if ("reason" in pushed) {
      const failed = findings(pushed);
      const after = tickets.markPushFailed(
        sessionId,
        live.ticket,
        pushed.reason,
        failed.head,
        failed.truncated,
      );
      return after ?? current();
    }
    const settled = tickets.markPushed(sessionId, live.ticket);
    if (settled === null) return current();
    live = settled;
  }

  if (!tickets.claimPr(sessionId, live.ticket)) {
    throw new CommandExecutionError(
      `ticket ${live.ticket} cannot open its pull request now: another call ` +
        `is already opening it, or the ticket left the pushed phase`,
    );
  }
  const opened = await runPhase(config.openPr, "open_pr");
  if ("reason" in opened) {
    const failed = findings(opened);
    const after = tickets.notePrFailed(
      sessionId,
      live.ticket,
      opened.reason,
      failed.head,
      failed.truncated,
    );
    return after ?? current();
  }
  const url = prUrlIn(opened.result.output);
  if (url === undefined) {
    const after = tickets.notePrFailed(
      sessionId,
      live.ticket,
      "open_pr succeeded but printed no pull request URL",
      findingLines(opened.result.output, opened.result.truncated),
      opened.result.truncated,
    );
    return after ?? current();
  }
  const done = tickets.markPrOpen(sessionId, live.ticket, url);
  return done ?? current();
}
