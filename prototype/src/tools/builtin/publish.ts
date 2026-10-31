/**
 * The publish tools (BIT-786): `publish/start`, `publish/status`,
 * `publish/cancel` and, when the operator configured a push and a pull
 * request, `publish/push`.
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
 * `publish/status`.
 *
 * `publish/push` ships a `ready` ticket: it pushes the gated commit with the
 * operator's `push` command and opens the pull request with `open_pr`. Because
 * an approval whose text is computed per call cannot bind a digest - the verdict
 * carries only command id, call id, title and arguments - the push approval
 * binds the commit by taking it as an ARGUMENT: every fact the operator must
 * see (`repository`, `branch`, `head`, `report`) is required, copied from
 * `publish/status`, and refused unless it equals the ticket's pin exactly.
 *
 * The gate takes 10-30 minutes by hand, which no tool call may hold open, so
 * `start` runs the pre-gate and the gate detached and returns at once with a
 * ticket:
 *
 * - `publish/start`  - pin the layout, create a ticket, run pre-gate then gate;
 * - `publish/status` - the ticket's phase, the pinned facts and the report;
 * - `publish/cancel` - stop the run's process group;
 * - `publish/push`   - push a gated commit, then open its pull request.
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
  layoutsMatch,
  readPublishGitLayout,
} from "./publish-git.ts";
import { runPush } from "./publish-push.ts";
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
  if (view.prUrl !== undefined) lines.push(`pr: ${view.prUrl}`);
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

/** The pins a run needs, or the reason it cannot start at all. */
type StartPins =
  | { readonly layout: GitLayout; readonly implementer: string }
  | { readonly refusal: string };

/**
 * Resolve what a run needs before it can start: the session workspace as an
 * anchored root, the git layout read from it host-side, and the implementing
 * models from the runtime's own record. One resolver, used by the precheck
 * (before the approval prompt) and the executor (again, after it): the layout
 * can change while a prompt is open, so the executor re-checks rather than
 * trusting the precheck.
 *
 * It creates nothing and writes nothing: no ticket, no process, no file. Every
 * refusal is a path-free sentence, never an exception's raw message.
 */
async function resolveStartPins(deps: PublishToolDeps): Promise<StartPins> {
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
    return {
      refusal: "the session workspace cannot be resolved as a git checkout: " +
        pathFreeReason(error),
    };
  }
  if (layout.head === null || layout.branchRef === null) {
    return {
      refusal: "the session workspace is not on a branch with a commit to gate",
    };
  }
  // The operator's gate picks a different-family reviewer from this list, so it
  // is read from the runtime's own event log rather than the worktree. An
  // unresolvable answer refuses the run: a gate told nothing about who
  // implemented cannot pick a different reviewer.
  const implementer = await deps.resolveImplementer(deps.sessionId);
  if (implementer === undefined || implementer === "") {
    return {
      refusal: "this session's implementing models cannot be resolved from " +
        "its own record, so {implementer} would be empty; publish/start " +
        "refuses rather than hand the gate an unknown implementer",
    };
  }
  return { layout, implementer };
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
  // Checked again here even though the precheck ran first: the layout can
  // change while the approval prompt is open, and this is the pass a started
  // run is pinned to.
  const pins = await resolveStartPins(deps);
  if ("refusal" in pins) throw new CommandExecutionError(pins.refusal);
  const { layout, implementer } = pins;
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
 * What `publish/push` will act on, or the reason it cannot: resolved from the
 * call's arguments and the ticket, and used by the precheck (before the
 * approval prompt) and the executor (again, after it). The ticket and the
 * layout can both change while a prompt is open, so the executor re-checks
 * rather than trusting the precheck.
 *
 * Every argument the operator must see is compared with the ticket's pin here.
 * The approval verdict carries only the command id, call id, title and
 * arguments, so the arguments ARE what was approved: an argument that differs
 * from the ticket means the operator approved something else.
 */
async function checkPushArguments(
  deps: PublishToolDeps,
  call: CommandCall,
): Promise<
  | { readonly view: PublishTicketView }
  | { readonly refusal: string }
> {
  const ticket = call.arguments["ticket"];
  if (typeof ticket !== "string") {
    return { refusal: "no ticket was named" };
  }
  const view = deps.tickets.get(deps.sessionId, ticket);
  if (view === null) {
    return {
      refusal: `this runtime holds no ticket ${ticket}; a ticket does not ` +
        "survive a restart, so start a new run with publish/start",
    };
  }
  if (view.phase !== "ready" && view.phase !== "pushed") {
    return {
      refusal: `ticket ${ticket} is in phase ${view.phase}; only a ticket in ` +
        "ready or pushed can be pushed or have its pull request opened",
    };
  }
  // Each pinned fact, as publish/status reported it. A mismatch is a refusal,
  // never a correction: the operator approved the arguments.
  const pinned: readonly (readonly [string, string | null])[] = [
    ["repository", view.repository],
    ["branch", view.branch],
    ["head", view.head],
    ["report", view.reportPath],
  ];
  for (const [name, expected] of pinned) {
    const given = call.arguments[name];
    const text = typeof given === "string" ? given : "";
    // A null pin (a detached head, an unborn branch) has no argument that
    // could equal it, so the call cannot describe what it would push.
    if (expected === null || text !== expected) {
      return {
        refusal: `the ${name} argument does not match ticket ${ticket}'s pin; ` +
          `copy every argument from publish/status`,
      };
    }
  }
  if (view.phase !== "ready") return { view };
  // A `ready` ticket is about to push, so the live layout must still be the
  // one the gate passed on.
  const readLayout = deps.readLayout ?? readPublishGitLayout;
  let live: GitLayout;
  try {
    live = await readLayout(view.repository);
  } catch (error) {
    return {
      refusal: `the layout could not be re-read (${pathFreeReason(error)})`,
    };
  }
  if (!layoutsMatch(live, view.layout)) {
    return {
      refusal: "the repository, branch or commit changed since the ticket was " +
        "created",
    };
  }
  return { view };
}

/**
 * `publish/push`'s executor: check the arguments again, then ship the ticket.
 * `runPush` owns every refusal that concerns the ticket's phase or the pins it
 * re-reads itself; this check is the approval's binding, and each of its
 * refusals leaves the ticket as it was.
 */
async function pushTicket(
  deps: PublishToolDeps,
  call: CommandCall,
): Promise<string> {
  const checked = await checkPushArguments(deps, call);
  if ("refusal" in checked) throw new CommandExecutionError(checked.refusal);
  const result = await runPush(
    {
      config: deps.config,
      tickets: deps.tickets,
      policy: deps.policy,
      sessionId: deps.sessionId,
      ...(deps.readLayout === undefined ? {} : { readLayout: deps.readLayout }),
      ...(deps.startCommand === undefined
        ? {}
        : { startCommand: deps.startCommand }),
    },
    checked.view.ticket,
  );
  return renderTicket(result, {
    outputHead: result.phase === "failed" || result.reason !== undefined,
  });
}

/**
 * `publish/push`, bound to one turn's deps. Separate from
 * `definePublishTools` because it is registered only when the operator
 * configured both a push and a pull request, not for every `[publish]` table.
 */
function definePushTool(deps: PublishToolDeps): CommandDefinition {
  const push: CommandDefinition = {
    id: "publish/push",
    title:
      "Push a gated commit and open its pull request (publishes to the remote)",
    description:
      "Push a publish ticket's gated commit with the operator's push command, " +
      "then open its pull request with open_pr. A ticket in phase ready is " +
      "pushed and then has its pull request opened; a ticket in phase pushed " +
      "whose pull request step failed retries only open_pr, never the push. " +
      "Every argument must be copied from publish/status for that ticket: the " +
      "call is refused unless repository, branch, head and report equal the " +
      "ticket's pins exactly, because those arguments are what the operator " +
      "approves. The pull request's title and body come from the commit. This " +
      "publishes to the remote, so it asks every time and is never granted " +
      "for a session.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: {
          type: "string",
          pattern: "^[0-9a-fA-F-]{36}$",
          description: "Ticket id from publish/status; the ticket to ship.",
        },
        repository: {
          type: "string",
          description: "The ticket's repository, copied from publish/status.",
        },
        branch: {
          type: "string",
          description: "The ticket's branch, copied from publish/status.",
        },
        head: {
          type: "string",
          pattern: "^[0-9a-f]{40}$",
          description: "The ticket's commit, copied from publish/status.",
        },
        report: {
          type: "string",
          description: "The ticket's report path, copied from publish/status.",
        },
      },
      required: ["ticket", "repository", "branch", "head", "report"],
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process", "write.external", "emit.event"],
      defaultDecision: "ask",
      resources: ["publish:push"],
      network: "external",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => pushTicket(deps, call),
    // Refuse before the approval prompt when the call cannot ship anything: a
    // refusal here raises no prompt. The executor checks again after approval.
    precheck: async (call) => {
      const checked = await checkPushArguments(deps, call);
      return "refusal" in checked
        ? `this push cannot run: ${checked.refusal}`
        : null;
    },
  };
  return push;
}

/**
 * `publish/start`, `publish/status`, `publish/cancel` and, with a configured
 * push and pull request, `publish/push`, bound to one turn's session and
 * workspace. Registered only when `[publish]` is configured: no command, no
 * tool.
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
    // Refuse before the approval prompt when the run cannot start: the same
    // resolution the executor does, so a refusal it detects raises no prompt.
    // The executor resolves again after approval.
    precheck: async () => {
      const pins = await resolveStartPins(deps);
      return "refusal" in pins
        ? `this run cannot start: ${pins.refusal}`
        : null;
    },
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

  const tools: CommandDefinition[] = [start, status, cancel];
  // Both commands this tool runs: a push with no pull request would leave a
  // published branch nobody opened a review for.
  if (deps.config.push !== undefined && deps.config.openPr !== undefined) {
    tools.push(definePushTool(deps));
  }
  return tools;
}

/** Re-exported so a caller can type a phase result without the module path. */
export type { PublishCommandResult, PublishPhaseName };
