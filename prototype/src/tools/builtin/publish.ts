/**
 * The publish tools (BIT-786, slice A): `publish/start`, `publish/status` and
 * `publish/cancel`.
 *
 * Publishing ships a session branch, so it is deliberately a host-side tool
 * and never a sandboxed command: the sandbox denies the GitHub domains
 * (`srt-policy.ts`), and the tool that ships a branch belongs where the
 * operator's own helpers run.
 *
 * `publish/start` runs the worktree's gate on the HOST, outside the sandbox. A
 * sandboxed command can plant code in the worktree, so starting a gate is host
 * execution of worktree code: it asks the operator every time, is never
 * grantable for a session, and its approval title carries that warning. The
 * title is STATIC - it names no commit; the pins a run resolved are shown by
 * `publish/status`. (An approval whose text is computed per call cannot bind a
 * digest anyway: the verdict carries only command id, call id, title and
 * arguments, so the next slice's push approval binds the commit by taking it as
 * an argument and re-checking it against HEAD at push time.)
 *
 * The gate takes 10-30 minutes by hand, which no tool call may hold open, so
 * `start` runs the pre-gate and the gate detached and returns at once with a
 * ticket:
 *
 * - `publish/start`  - pin the layout, create a ticket, run pre-gate then gate;
 * - `publish/status` - the ticket's phase, the pinned facts and the report;
 * - `publish/cancel` - stop the run's process group.
 *
 * Tickets live in the runtime's memory (`publish-tickets.ts`). A restart makes
 * `status` report `unknown` rather than guess from a file on disk.
 */

import {
  type CommandCall,
  CommandExecutionError,
  type CommandDefinition,
} from "../definition.ts";
import type { RuntimePolicy } from "../../config/runtime-policy.ts";
import {
  type PublishConfig,
  publishReportPathFor,
  type PublishValues,
} from "../../config/publish-config.ts";
import type { Env } from "../../config/mod.ts";
import {
  FINDING_LINES,
  type PublishPhaseName,
  pathFreeReason,
  runGates,
  PublishReport,
  sandboxWriteCheck,
} from "./publish-phase.ts";
import {
  type GitLayout,
  readPublishGitLayout,
} from "./publish-git.ts";
import { type PublishCommandResult, startPublishCommand } from "./publish-run.ts";
import {
  branchOf,
  type PublishTicketView,
  PublishTickets,
} from "./publish-tickets.ts";

export { FINDING_LINES, FINDING_LINE_MAX, findingLines } from "./publish-phase.ts";

/** The one line the start prompt must carry: it is host execution. */
export const HOST_EXECUTION_WARNING =
  "runs this worktree's tests on the host, outside the sandbox";

/** What the publish tools need, resolved once per turn by the engine. */
export interface PublishToolDeps {
  config: PublishConfig;
  /** The runtime's registry, owned by the composition root. */
  tickets: PublishTickets;
  /** The runtime's policy: a configured command must be one it may start. */
  policy: RuntimePolicy;
  sessionId: string;
  /** The turn's resolved workspace root, verified against the anchors. */
  workspaceRoot: string;
  rootAnchors: import("./root-anchors.ts").RootAnchors;
  env?: Env;
  /** The git layout reader; injectable so tests need no checkout. */
  readLayout?: (root: string) => Promise<GitLayout>;
  /** The command runner; injectable so tests need no real gate. */
  startCommand?: typeof startPublishCommand;
  /**
   * The families that ran this session's turns, from the runtime's own record
   * (`publish-implementer.ts`). Injectable so tests need no event log.
   */
  resolveImplementer: (
    sessionId: string,
  ) => Promise<string | undefined>;
}

/** The ticket as the model and the operator read it. */
export function renderTicket(
  view: PublishTicketView,
  options: { outputHead?: boolean } = {},
): string {
  const lines = [
    `ticket: ${view.ticket}`,
    `phase: ${view.phase}`,
    `repository: ${view.repository}`,
    `branch: ${view.branch ?? "(detached head)"}`,
    `head: ${view.head ?? "(no commit)"}`,
    `report: ${view.reportPath}`,
  ];
  if (view.reportError !== undefined) {
    lines.push(`report incomplete: ${view.reportError}`);
  }
  if (view.failedPhase !== undefined) {
    lines.push(`failed phase: ${view.failedPhase}`);
  }
  if (view.reason !== undefined) lines.push(`reason: ${view.reason}`);
  if (options.outputHead === true && view.outputHead !== undefined) {
    lines.push(
      `findings (first ${FINDING_LINES} non-empty lines${
        view.truncatedOutput ? ", truncated" : ""
      }):`,
      view.outputHead,
    );
  }
  return lines.join("\n");
}

/** The values one substitution fills, from the ticket's pinned facts. */
function placeholdersFor(
  facts: {
    repository: string;
    branch: string | null;
    head: string | null;
    issue: string | undefined;
    implementer: string;
  },
  ticket: string,
): PublishValues {
  return {
    repo: facts.repository,
    branch: facts.branch ?? "",
    head: facts.head ?? "",
    range: "origin/main...HEAD",
    issue: facts.issue ?? "",
    implementer: facts.implementer,
    report: "",
    ticket,
  };
}

/**
 * `publish/start`'s executor: resolve the pins host-side, create the ticket,
 * then run the phases detached. The workspace and implementer are checked
 * before a ticket exists; a failure after that is recorded on the ticket.
 */
async function startPublishRun(
  deps: PublishToolDeps,
  call: CommandCall,
): Promise<string> {
  const issue = call.arguments["issue"];
  if (issue !== undefined && typeof issue !== "string") {
    throw new CommandExecutionError("issue must be a tracker identifier");
  }
  const readLayout = deps.readLayout ?? readPublishGitLayout;
  // The root is the one this turn resolved and anchored, never a path read out
  // of the worktree.
  const root = await deps.rootAnchors.verify(deps.workspaceRoot);
  let layout: GitLayout;
  try {
    layout = await readLayout(root);
  } catch (error) {
    // A root that is not a checkout the runtime can read is the model's
    // problem to report, not a runtime fault.
    throw new CommandExecutionError(
      `the session workspace cannot be resolved as a git checkout: ${
        pathFreeReason(error)
      }`,
    );
  }
  if (layout.head === null || layout.branchRef === null) {
    throw new CommandExecutionError(
      "the session workspace is not on a branch with a commit to gate",
    );
  }
  // The operator's gate picks a different-family reviewer from this list, so it
  // is read from the runtime's own event log rather than the worktree. An
  // unresolvable answer refuses the run: a gate told nothing about who
  // implemented cannot pick a different reviewer.
  const implementer = await deps.resolveImplementer(deps.sessionId);
  if (implementer === undefined || implementer === "") {
    throw new CommandExecutionError(
      "this session's implementing models cannot be resolved from its own " +
        "record, so {implementer} would be empty; publish/start refuses rather " +
        "than hand the gate an unknown implementer",
    );
  }
  const created = deps.tickets.create({
    sessionId: deps.sessionId,
    layout,
    // The default path names the ticket, so it is filled from the id this
    // module just minted.
    reportPathFor: (ticket) =>
      publishReportPathFor(
        deps.config,
        placeholdersFor(
          {
            repository: layout.topLevel,
            branch: branchOf(layout),
            head: layout.head,
            issue: issue as string | undefined,
            implementer,
          },
          ticket,
        ),
      ),
    ...(issue === undefined ? {} : { trackerIssue: issue as string }),
  });
  const report = new PublishReport(created.reportPath, {
    writableBySandbox: sandboxWriteCheck(created.layout),
  });
  // Detached, with a handler attached on both paths: every anticipated failure
  // is already the ticket's, and the handler also keeps a defect inside the
  // runner from becoming an unhandled rejection. Either way the report closes.
  void runGates(
    {
      config: deps.config,
      tickets: deps.tickets,
      policy: deps.policy,
      sessionId: deps.sessionId,
      readLayout,
      ...(deps.startCommand === undefined
        ? {}
        : { startCommand: deps.startCommand }),
    },
    created,
    issue as string | undefined,
    implementer,
    report,
  ).then(
    () => report.close(),
    (error: unknown) => {
      // A defect inside the runner must still leave a failed ticket, not only
      // a closed report: the operator has to be able to read what happened.
      // The phase that was running: a ticket already marked gated failed in
      // the gate.
      const phase = deps.tickets.get(deps.sessionId, created.ticket)?.phase;
      deps.tickets.markFailed(
        deps.sessionId,
        created.ticket,
        phase === "gated" ? "gate" : "pre-gate",
        `the run stopped unexpectedly: ${pathFreeReason(error)}`,
        "",
        false,
        report.writeError,
      );
      return report.close();
    },
  );
  return renderTicket(created);
}

/**
 * `publish/start`, `publish/status` and `publish/cancel`, bound to one turn's
 * session and workspace. Registered only when `[publish]` is configured: no
 * command, no tool.
 */
export function definePublishTools(
  deps: PublishToolDeps,
): readonly CommandDefinition[] {
  const sessionId = deps.sessionId;
  const readLayout = deps.readLayout ?? readPublishGitLayout;

  const start: CommandDefinition = {
    id: "publish/start",
    title: `Start a publish run (${HOST_EXECUTION_WARNING})`,
    description:
      "Start a publish run for this session's branch: resolve the repository, " +
      "branch and commit host-side, then run the operator's pre-gate and gate " +
      "in the background and return a ticket. It " +
      `${HOST_EXECUTION_WARNING}: the gate runs the worktree's own code with ` +
      "the runtime's privileges, so this asks every time and is never granted " +
      "for a session. Poll with publish/status; a gate takes minutes. This tool " +
      "does not push or open a pull request itself; what the configured " +
      "commands do is the operator's choice.",
    inputSchema: {
      type: "object",
      properties: {
        issue: {
          type: "string",
          pattern: "^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,30}$",
          description:
            "Optional tracker identifier, passed to the operator's commands " +
            "as {issue}.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process", "write.filesystem", "emit.event"],
      defaultDecision: "ask",
      resources: ["publish:gate"],
      // The operator's gate may reach the network; declaring it keeps every
      // auto-allow path away from this tool.
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    executor: (call) => startPublishRun(deps, call),
  };

  const status: CommandDefinition = {
    id: "publish/status",
    title: "Publish status",
    description:
      "Report a publish run: its phase, the resolved repository, branch and " +
      "commit, the gate report path, and - when a gate stopped it - why and " +
      "the first non-empty lines of its output. Reports 'unknown' for a ticket " +
      "this runtime no longer holds, because a ticket does not survive a " +
      "restart.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: {
          type: "string",
          pattern: "^[0-9a-fA-F-]{36}$",
          description: "Ticket id from publish/start; omit for the newest.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["publish:ticket"],
      network: "none",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => {
      const ticket = call.arguments["ticket"];
      const view = typeof ticket === "string" && ticket !== ""
        ? deps.tickets.get(sessionId, ticket)
        : deps.tickets.latest(sessionId);
      if (view === null) {
        return "unknown: this runtime holds no such publish ticket. A ticket " +
          "does not survive a restart; start a new run with publish/start.";
      }
      return renderTicket(view, { outputHead: view.phase === "failed" });
    },
  };

  const cancel: CommandDefinition = {
    id: "publish/cancel",
    title: "Cancel a publish run",
    description:
      "Stop a running pre-gate or gate: the command's whole process group is " +
      "stopped and the ticket records the cancel. A finished or unheld ticket " +
      "reports that there was nothing to cancel.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: {
          type: "string",
          pattern: "^[0-9a-fA-F-]{36}$",
          description: "Ticket id from publish/start; omit for the newest.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process", "emit.event"],
      defaultDecision: "ask",
      resources: ["publish:ticket"],
      network: "none",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => {
      const ticket = call.arguments["ticket"];
      const id = typeof ticket === "string" && ticket !== ""
        ? ticket
        : deps.tickets.latest(sessionId)?.ticket;
      if (id === undefined) {
        return "unknown: this runtime holds no publish ticket to cancel.";
      }
      const view = deps.tickets.cancel(sessionId, id);
      return view === null
        ? `nothing to cancel: ticket ${id} is not running a gate`
        : renderTicket(view);
    },
  };

  return [start, status, cancel];
}

/** Re-exported so a caller can type a phase result without the module path. */
export type { PublishCommandResult, PublishPhaseName };
