/**
 * Subject integrity checks: `subject.resolve` and `subject.digest`.
 *
 * `subject.resolve` proves the tree being checked is the intended immutable
 * commit. In CI (`GITHUB_ACTIONS=true`) the workflow binds the checked-out
 * commit through `DYFJ_GATE_SUBJECT`; a missing or non-immutable binding, a
 * HEAD that differs from the bound subject, or local modifications to the
 * subject tree fail closed. A local invocation without the binding resolves
 * HEAD and labels the result explicitly non-authoritative: local runs are
 * working-tree feedback, never publication evidence.
 *
 * `subject.digest` recomputes the commit digest from the raw commit object
 * bytes (`sha1("commit <len>\0" + body)`) instead of trusting the reference,
 * and reports the git tool revision used. A recomputation mismatch — for
 * example an object-store corruption or an unsupported object format — fails
 * closed.
 *
 * Diagnostics are value-free: commit ids and the git version string are the
 * only dynamic content; git stderr is never relayed (see `scan-lib.ts`).
 */

import { gitStdout, repoRootFromMeta, sanitizeForLog } from "./scan-lib.ts";

const LABEL = "subject check";

export type EnvReader = (name: string) => string | undefined;

export interface SubjectBinding {
  expected?: string;
  authoritative: boolean;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

export function resolveSubjectBinding(env: EnvReader): SubjectBinding {
  const ci = env("GITHUB_ACTIONS") === "true";
  const expected = env("DYFJ_GATE_SUBJECT");
  if (expected === undefined || expected === "") {
    if (ci) {
      throw new Error(
        `${LABEL}: CI run without a bound subject; failing closed`,
      );
    }
    return { authoritative: false };
  }
  if (!FULL_SHA.test(expected) || ZERO_SHA.test(expected)) {
    // A branch name, short id, or zero id is not an immutable subject.
    throw new Error(
      `${LABEL}: bound subject is not a full immutable commit id; ` +
        "failing closed",
    );
  }
  return { expected, authoritative: ci };
}

export async function headCommit(
  root: string,
  gitCommand = "git",
): Promise<string> {
  const stdout = await gitStdout(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    LABEL,
    gitCommand,
  );
  const head = new TextDecoder().decode(stdout).trim();
  if (!FULL_SHA.test(head)) {
    throw new Error(`${LABEL}: could not resolve HEAD to a full commit id`);
  }
  return head;
}

export async function isWorktreeClean(
  root: string,
  gitCommand = "git",
): Promise<boolean> {
  const stdout = await gitStdout(
    root,
    ["status", "--porcelain"],
    LABEL,
    gitCommand,
  );
  return stdout.length === 0;
}

// Recomputes the commit digest from the object bytes: git's object id is
// sha1 over `commit <byte-length>\0<body>`. Matching the reference proves
// the digest, not just the name. A sha256-object-format repository fails the
// comparison and therefore fails closed as unsupported.
export async function recomputeCommitDigest(
  root: string,
  commit: string,
  gitCommand = "git",
): Promise<string> {
  const body = await gitStdout(
    root,
    ["cat-file", "commit", commit],
    LABEL,
    gitCommand,
  );
  const header = new TextEncoder().encode(`commit ${body.length}\0`);
  const object = new Uint8Array(header.length + body.length);
  object.set(header, 0);
  object.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", object);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function gitToolRevision(
  root: string,
  gitCommand = "git",
): Promise<string> {
  const stdout = await gitStdout(root, ["--version"], LABEL, gitCommand);
  return sanitizeForLog(new TextDecoder().decode(stdout).trim(), 80);
}

export const SUBJECT_CHECKS = ["subject.resolve", "subject.digest"] as const;
export type SubjectCheck = (typeof SUBJECT_CHECKS)[number];

export interface SubjectCheckOptions {
  root: string;
  env: EnvReader;
  gitCommand?: string;
  out?: Pick<Console, "log" | "error">;
}

export async function runSubjectCheck(
  check: SubjectCheck,
  options: SubjectCheckOptions,
): Promise<number> {
  const out = options.out ?? console;
  const git = options.gitCommand ?? "git";
  const binding = resolveSubjectBinding(options.env);
  const head = await headCommit(options.root, git);
  if (binding.expected !== undefined && head !== binding.expected) {
    out.error(
      `${check}: HEAD ${head} does not match the bound subject ` +
        `${binding.expected}; failing closed`,
    );
    return 1;
  }
  const mode = binding.authoritative
    ? "authoritative CI binding"
    : "non-authoritative local resolution";
  if (check === "subject.resolve") {
    if (binding.authoritative && !(await isWorktreeClean(options.root, git))) {
      out.error(
        `${check}: the subject tree carries local modifications; ` +
          "failing closed",
      );
      return 1;
    }
    out.log(`${check}: pass (${head}, ${mode})`);
    return 0;
  }
  const recomputed = await recomputeCommitDigest(options.root, head, git);
  if (recomputed !== head) {
    out.error(
      `${check}: recomputed object digest does not match the subject ` +
        "reference; failing closed",
    );
    return 1;
  }
  const tool = await gitToolRevision(options.root, git);
  out.log(`${check}: pass (sha1 ${head} recomputed; ${tool}; ${mode})`);
  return 0;
}

if (import.meta.main) {
  const [flag, check] = Deno.args;
  if (
    Deno.args.length !== 2 || flag !== "--check" ||
    !(SUBJECT_CHECKS as readonly string[]).includes(check ?? "")
  ) {
    console.error(`${LABEL}: usage: --check <subject.resolve|subject.digest>`);
    Deno.exit(64);
  }
  let code: number;
  try {
    code = await runSubjectCheck(check as SubjectCheck, {
      root: repoRootFromMeta(),
      env: (name) => Deno.env.get(name),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    code = 1;
  }
  Deno.exit(code);
}
