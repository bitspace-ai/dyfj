/**
 * `write_file` and `edit_file`'s write, in the isolated machine's executor
 * (BIT-796), or, without one, in the srt sandbox when its boot probe passed
 * (BIT-662). There the sandbox's write policy (`srt-policy.ts`) bounds the
 * write instead of the executor's mounts and Landlock rules; the rest of
 * this comment describes the executor route. With an executor socket set, the write runs there and never in
 * the runtime: the executor's mounts and Landlock rules decide what it can
 * write, which is the workspace and its scratch space, as for bash. The
 * attested envelope can then cover the write as it covers bash
 * (`tools/policy.ts`).
 *
 * The path checks `executeWriteFile` makes run again inside the executor,
 * against the executor's own view of the filesystem: a relative path inside
 * the root, a real parent inside the root, no `.git` segment, and a final
 * component that is not a symlink (`O_NOFOLLOW`). A new file is created
 * readable by its owner and group only (0660, less the umask); an existing
 * file keeps its mode. The checks run before the
 * file is opened, so a directory swapped between the check and the open is
 * not caught; what bounds the write is the executor's mounts and Landlock
 * rules, the same as for bash, which can write anywhere in the workspace,
 * `.git` included. The runtime makes the lexical checks first, so a refused
 * path reads the same on both routes.
 *
 * The content travels on the process's standard input, never in argv,
 * where other users could read it from `/proc` while the write runs. The
 * supervisor accepts a request line of at most 1 MiB, so one write is capped
 * below that, after JSON escaping.
 */

import { Buffer } from "node:buffer";
import { relative } from "node:path";
import type { Env } from "../../config/mod.ts";
import type { WorkspaceRoot } from "./root-anchors.ts";
import { insideGitDir } from "./file-write.ts";
import {
  resolveWorkspacePath,
  safeErrorReason,
  sanitizeOutputText,
} from "./file-access.ts";
import { buildSafeBashEnv } from "./exec.ts";
import type { BoundedResult } from "./bounded-process.ts";

/** The deadline for one contained write; a write takes no deadline from the model. */
export const CONTAINED_WRITE_TIMEOUT_MS = 30_000;

/** The largest content one contained write takes, in bytes. */
export const CONTAINED_WRITE_MAX_BYTES = 512 * 1024;

/** The most the content may take on the wire once JSON-escaped. */
const MAX_ESCAPED_BYTES = 960 * 1024;

/**
 * Runs one argv in the executor at `cwd`, with `stdin` as its standard
 * input; `binding` as for bash.
 */
export type ContainedProcessRunner = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  binding: string | undefined,
  stdin: string,
) => Promise<BoundedResult>;

/**
 * The program the executor runs, as `node -e <script> -- <path>`, with the
 * content on its standard input (`--` so a path starting with `-` is not
 * read as a node option). It
 * prints one status word and exits 0: `ok`, `escape`, `git`, `symlink`, or
 * `error <code>`. It names no path, so its output cannot echo one.
 */
export const CONTAINED_WRITE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const [rel] = process.argv.slice(1);
const inside = (root, target) => {
  const r = path.relative(root, target);
  return !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r));
};
const underGit = (r) => r.split(/[\\\\/]/).some((s) => s.toLowerCase() === ".git");
const status = (() => {
  try {
    const root = fs.realpathSync(".");
    if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel)) return "escape";
    const abs = path.resolve(root, rel);
    if (!inside(root, abs)) return "escape";
    if (underGit(path.relative(root, abs))) return "git";
    const parent = fs.realpathSync(path.dirname(abs));
    if (!inside(root, parent)) return "escape";
    const target = path.join(parent, path.basename(abs));
    if (underGit(path.relative(root, target))) return "git";
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return "symlink";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const c = fs.constants;
    const fd = fs.openSync(target, c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_NOFOLLOW, 0o660);
    try {
      fs.writeFileSync(fd, fs.readFileSync(0));
    } finally {
      fs.closeSync(fd);
    }
    return "ok";
  } catch (error) {
    return "error " + (error && typeof error.code === "string" ? error.code : "unknown");
  }
})();
process.stdout.write(status);
`;

/** The argv for writing to `p`. The content is not in it. */
export function containedWriteArgv(p: string): string[] {
  return ["node", "-e", CONTAINED_WRITE_SCRIPT, "--", p];
}

/** The tool result for the executor's status word. */
function resultFor(p: string, result: BoundedResult, where: string): string {
  const shown = sanitizeOutputText(p);
  if (result.timedOut || result.code !== 0) {
    return `error: cannot write ${shown}: ${where} did not finish the write`;
  }
  const status = result.stdout.trim();
  if (status === "ok") return `wrote ${shown}`;
  if (status === "escape") return `error: path escapes the workspace root: ${shown}`;
  if (status === "git") return `error: refusing to write inside .git: ${shown}`;
  if (status === "symlink") return `error: refusing to write through a symlink: ${shown}`;
  const code = /^error ([A-Z_]{1,32})$/.exec(status)?.[1];
  return `error: cannot write ${shown}: ${
    code === undefined ? "unknown error" : safeErrorReason({ code })
  }`;
}

/**
 * Write `content` to `p` through the executor. Returns `wrote <p>` or an
 * `error: …` line, as `executeWriteFile` does; never throws.
 */
export async function executeContainedWrite(
  workspace: WorkspaceRoot,
  run: ContainedProcessRunner,
  p: string,
  content: string,
  opts: { env?: Env; binding?: string; where?: string } = {},
): Promise<string> {
  const where = opts.where ?? "the isolated executor";
  let abs: string;
  try {
    abs = resolveWorkspacePath(workspace.path, p);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  if (insideGitDir(relative(workspace.path, abs))) {
    return `error: refusing to write inside .git: ${sanitizeOutputText(p)}`;
  }
  const size = Buffer.byteLength(content, "utf8");
  if (size > CONTAINED_WRITE_MAX_BYTES) {
    return `error: cannot write ${sanitizeOutputText(p)}: the content is ${size} bytes, ` +
      `above the ${CONTAINED_WRITE_MAX_BYTES} bytes one write in ${where} takes`;
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_ESCAPED_BYTES) {
    return `error: cannot write ${sanitizeOutputText(p)}: the content has too many ` +
      `control characters to send to ${where} in one write`;
  }
  try {
    const root = await workspace.verify();
    const result = await run(
      containedWriteArgv(p),
      root,
      CONTAINED_WRITE_TIMEOUT_MS,
      buildSafeBashEnv(opts.env),
      opts.binding,
      content,
    );
    return resultFor(p, result, where);
  } catch (err) {
    return `error: cannot write ${sanitizeOutputText(p)}: ${
      err instanceof Error && err.message.startsWith("executor unavailable")
        ? `${where} is unavailable`
        : safeErrorReason(err)
    }`;
  }
}
