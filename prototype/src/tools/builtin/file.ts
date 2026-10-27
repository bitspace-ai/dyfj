/**
 * Workspace file tools for the agent loop, scoped to a workspace root.
 *
 * `read_file`, `list_files`, `grep_files` and `glob_files` are read-only and
 * side-effect-free (the policy auto-allows them). `write_file` is mutating —
 * the command policy routes it through operator approval, so its executor never
 * runs unapproved. Every path is resolved within the root and traversal/symlink
 * escape is rejected, so the model can only touch the project it's working in.
 * `edit_file` applies a single exact-string replacement (also mutating).
 *
 * This module holds the definitions; the executors live beside it, grouped by
 * what they do: `file-read.ts` (read, list), `file-write.ts` (write, edit),
 * `file-search.ts` (grep, glob, and the traversal behind them), `file-glob.ts`
 * (the glob matcher), and `file-access.ts` (containment, verified reads and
 * output escaping, shared by all of them).
 *
 * Auto-approval means no operator sits between the model and these executors,
 * so their resource ceilings are a security boundary rather than a courtesy.
 * The search tools carry the heaviest ones; see the section comment in
 * `file-search.ts` for what is enforced and what is deliberately left open.
 *
 * Executors never throw on operator/model error (bad path, missing file,
 * traversal attempt): they return an `error: …` string so the model sees the
 * failure as a tool result and can recover, rather than crashing the turn.
 */

import { Buffer } from "node:buffer";
import type { Env } from "../../config/mod.ts";
import type { CommandDefinition, Containment } from "../definition.ts";
import { createContainment } from "./containment.ts";
import { type CommandSandbox, sandboxContainment } from "./srt-sandbox.ts";
import { executorSocket, undialable } from "./exec.ts";
import type { ExecutorDialer } from "./executor-transport.ts";
import { createExecutorProcessRunner } from "./executor-transport.ts";
import { sanitizeOutputText } from "./file-access.ts";
import {
  CONTAINED_WRITE_MAX_BYTES,
  CONTAINED_WRITE_TIMEOUT_MS,
  type ContainedProcessRunner,
  executeContainedWrite,
} from "./file-write-contained.ts";
import type { WorkspaceRoot } from "./root-anchors.ts";
import { executeListFiles, executeReadFile } from "./file-read.ts";
import { executeEditFile, executeWriteFile } from "./file-write.ts";
import { executeGlobFiles, executeGrepFiles } from "./file-search.ts";

// ── Command definitions ──────────────────────────────────────────────────────

export function defineReadFile(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "read_file",
    title: "Read File",
    description:
      "Read a UTF-8 text file from the workspace, by path relative to the " +
      "workspace root. Read-only.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        offset: {
          type: "number",
          description:
            "1-based line to start at. Use with limit to read a large file in " +
            "pieces instead of shelling out to sed/head/tail.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return, starting at offset.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) =>
      executeReadFile(workspace, String(call.arguments.path), undefined, {
        offset: call.arguments.offset === undefined
          ? undefined
          : Number(call.arguments.offset),
        limit: call.arguments.limit === undefined
          ? undefined
          : Number(call.arguments.limit),
      }),
  };
}

export function defineListFiles(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "list_files",
    title: "List Files",
    description:
      "List the entries of a workspace directory, by path relative to the " +
      "workspace root (omit for the root). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to the workspace root; defaults to the root.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) =>
      executeListFiles(
        workspace,
        call.arguments.path === undefined ? "." : String(call.arguments.path),
      ),
  };
}

export function defineGrepFiles(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "grep_files",
    title: "Search File Contents",
    description:
      "Search workspace file contents with a regular expression. Returns " +
      "`path:line:text` rows. Prefer this over running grep/rg through bash: " +
      "it is read-only and needs no approval. Every path it returns is " +
      "verified to resolve inside the workspace. Scope excludes node_modules, " +
      ".git, .jj, .hg and .svn by contract — searching those requires bash. " +
      "Anything ELSE the search saw and declined (a ceiling, a skipped binary " +
      "or symlink, an unreadable directory) is reported in a trailing note. A " +
      "note means content was left out; no note means nothing seen was " +
      "skipped, which is weaker than proof of absence if the tree is changing " +
      "underneath the search.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "JavaScript regular expression, matched line by line. Matching runs " +
            "under a wall-clock budget; an expensive pattern is cut off rather " +
            "than allowed to run long.",
        },
        path: {
          type: "string",
          description:
            "Directory to search, relative to the workspace root; defaults to the root.",
        },
        include: {
          type: "string",
          description:
            "Optional glob limiting which files are searched, e.g. `**/*.ts`.",
        },
        // The stated cap is advisory: executeGrepFiles clamps this against a
        // ceiling it owns, so asking for more buys nothing.
        maxMatches: {
          type: "number",
          description:
            "Maximum rows to return (default 200, clamped to at most 1000).",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) =>
      executeGrepFiles(workspace, String(call.arguments.pattern), {
        path: call.arguments.path === undefined
          ? undefined
          : String(call.arguments.path),
        include: call.arguments.include === undefined
          ? undefined
          : String(call.arguments.include),
        maxMatches: call.arguments.maxMatches === undefined
          ? undefined
          : Number(call.arguments.maxMatches),
      }),
  };
}

export function defineGlobFiles(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "glob_files",
    title: "Find Files By Pattern",
    description:
      "Find workspace files whose relative path matches a glob, e.g. " +
      "`**/*.test.ts`. Read-only; prefer this over running find/ls through " +
      "bash. Returns only paths verified to resolve inside the workspace. " +
      "Scope excludes node_modules, .git, .jj, .hg and .svn by contract; " +
      "anything else the search saw and declined is reported in a trailing " +
      "note. No note means nothing seen was skipped, not that the tree held " +
      "still while it looked.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Glob matched against the workspace-relative path.",
        },
        path: {
          type: "string",
          description:
            "Directory to search, relative to the workspace root; defaults to the root.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) =>
      executeGlobFiles(workspace, String(call.arguments.pattern), {
        path: call.arguments.path === undefined
          ? undefined
          : String(call.arguments.path),
      }),
  };
}

/** The executor options of the write tools: as for bash and git. */
export interface WriteToolOptions {
  env?: Env;
  dialExecutor?: ExecutorDialer;
  sandbox?: CommandSandbox;
}

/**
 * The write tools' route. With an executor socket set, the write runs in the
 * executor (`file-write-contained.ts`) and its approval comes from the
 * attested envelope, as bash's does (BIT-796); without a dialer, every write
 * is refused rather than made here. Without a socket, when the srt sandbox's
 * boot probe passed, the same write program runs in the sandbox (BIT-662),
 * whose policy bounds what it can write.
 */
interface WriteRoute {
  containment?: Containment;
  run?: ContainedProcessRunner;
  env?: Env;
  /** Where the write runs, as results name it. */
  where?: string;
}

function writeRoute(
  workspace: WorkspaceRoot,
  opts: WriteToolOptions,
): WriteRoute {
  const socket = executorSocket(opts.env);
  if (socket === undefined) {
    const sandbox = opts.sandbox;
    if (sandbox === undefined || sandbox.status.state !== "on") return {};
    return {
      containment: sandboxContainment(sandbox),
      run: (argv, cwd, timeoutMs, env, _binding, stdin) =>
        sandbox.runArgv(argv, {
          root: workspace.path,
          cwd,
          timeoutMs,
          env,
          stdin,
        }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      where: "the sandbox",
    };
  }
  return {
    containment: createContainment(socket, opts.dialExecutor, {
      defaultCommandTimeoutMs: CONTAINED_WRITE_TIMEOUT_MS,
      callTimeoutMs: () => CONTAINED_WRITE_TIMEOUT_MS,
    }),
    run: opts.dialExecutor === undefined
      ? undialable
      : createExecutorProcessRunner(socket, opts.dialExecutor),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  };
}

/** How the write tools' descriptions state approval, per route. */
function writeApproval(route: WriteRoute): string {
  return route.run === undefined
    ? "Mutating — requires operator approval before it runs."
    : route.where === "the sandbox"
    ? "Mutating. The write runs in an OS sandbox whose only writable places " +
      "are the workspace, srt's scratch directory, npm's log directory and " +
      "what a commit on the session branch needs; it runs without a prompt under the operator posture on the local socket and " +
      "otherwise requires operator approval."
    : "Mutating. The write runs in the isolated executor, and requires " +
      "operator approval before it runs unless the operator granted the " +
      "executor's attested envelope, the executor's containment is attested " +
      "for the call, and the call is within the envelope's limits.";
}

export function defineWriteFile(
  workspace: WorkspaceRoot,
  opts: WriteToolOptions = {},
): CommandDefinition<string> {
  const route = writeRoute(workspace, opts);
  return {
    id: "write_file",
    ...(route.containment === undefined ? {} : { containment: route.containment }),
    title: "Write File",
    description:
      "Write UTF-8 text to a file in the workspace, by path relative to the " +
      "workspace root, creating or overwriting it. " + writeApproval(route),
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 text to write to the file.",
          // Redacted from the persisted tool-call event + session replay; the
          // raw body is written to the file, never retained in the audit log.
          redact: true,
        },
      },
      additionalProperties: false,
    },
    permission: {
      // defaultDecision "allow" + filesystem "write" routes through "ask" in
      // evaluateCommandPolicy (the write-fs branch) — i.e. operator approval.
      effects: ["write.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:write"],
      network: "none",
      filesystem: "write",
      cost: "none",
    },
    executor: (call, context) =>
      route.run === undefined
        ? executeWriteFile(
          workspace,
          String(call.arguments.path),
          String(call.arguments.content),
        )
        : executeContainedWrite(
          workspace,
          route.run,
          String(call.arguments.path),
          String(call.arguments.content),
          {
            ...(route.env === undefined ? {} : { env: route.env }),
            ...(context.binding === undefined ? {} : { binding: context.binding }),
            ...(route.where === undefined ? {} : { where: route.where }),
          },
        ),
  };
}

export function defineEditFile(
  workspace: WorkspaceRoot,
  opts: WriteToolOptions = {},
): CommandDefinition<string> {
  const route = writeRoute(workspace, opts);
  return {
    id: "edit_file",
    ...(route.containment === undefined ? {} : { containment: route.containment }),
    title: "Edit File",
    description:
      "Replace an exact text fragment in an existing file in the workspace, by " +
      "path relative to the workspace root. The old text must occur exactly " +
      "once. " + writeApproval(route),
    inputSchema: {
      type: "object",
      required: ["path", "old_string", "new_string"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        old_string: {
          type: "string",
          description:
            "Exact text to replace; must occur exactly once in the file.",
          // Payload-bearing file content — redacted from the persisted event.
          redact: true,
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
          redact: true,
        },
      },
      additionalProperties: false,
    },
    permission: {
      // Same contained-write envelope as write_file: routes through "ask" under
      // strict, auto-approves under the operator profile on a loopback turn.
      effects: ["write.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:write"],
      network: "none",
      filesystem: "write",
      cost: "none",
    },
    executor: (call, context) =>
      route.run !== undefined &&
        Buffer.byteLength(String(call.arguments.new_string), "utf8") >
          CONTAINED_WRITE_MAX_BYTES
        ? Promise.resolve(
          `error: cannot edit ${sanitizeOutputText(String(call.arguments.path))}: ` +
            `new_string is above the ${CONTAINED_WRITE_MAX_BYTES} bytes one write ` +
            `in ${route.where ?? "the isolated executor"} takes`,
        )
        : executeEditFile(
        workspace,
        String(call.arguments.path),
        String(call.arguments.old_string),
        String(call.arguments.new_string),
        undefined,
        route.run === undefined ? undefined : {
          write: (p, content) =>
            executeContainedWrite(workspace, route.run!, p, content, {
              ...(route.env === undefined ? {} : { env: route.env }),
              ...(context.binding === undefined ? {} : { binding: context.binding }),
              ...(route.where === undefined ? {} : { where: route.where }),
            }),
          maxBytes: CONTAINED_WRITE_MAX_BYTES,
        },
      ),
  };
}
