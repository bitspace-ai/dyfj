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

import type { CommandDefinition } from "../definition.ts";
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

export function defineWriteFile(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "write_file",
    title: "Write File",
    description:
      "Write UTF-8 text to a file in the workspace, by path relative to the " +
      "workspace root, creating or overwriting it. Mutating — requires " +
      "operator approval before it runs.",
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
    executor: (call) =>
      executeWriteFile(
        workspace,
        String(call.arguments.path),
        String(call.arguments.content),
      ),
  };
}

export function defineEditFile(
  workspace: WorkspaceRoot,
): CommandDefinition<string> {
  return {
    id: "edit_file",
    title: "Edit File",
    description:
      "Replace an exact text fragment in an existing file in the workspace, by " +
      "path relative to the workspace root. The old text must occur exactly " +
      "once. Mutating — requires operator approval before it runs.",
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
    executor: (call) =>
      executeEditFile(
        workspace,
        String(call.arguments.path),
        String(call.arguments.old_string),
        String(call.arguments.new_string),
      ),
  };
}
