/**
 * Admission of the extra roots a session asks for beside its workspace
 * (`--add-dir`).
 *
 * An added root widens what the file tools and the Codex route may reach, so
 * the runtime checks each one before a turn uses it. Each root is resolved
 * to its canonical path and must be a directory. A root is refused when it
 * is, sits inside, or contains a protected path: the runtime's own directory
 * (`~/.dyfj`, which holds the runner homes), `~/.config/dyfj`, the config
 * root `DYFJ_ROOT`, the Codex runner home, or the file behind the runtime
 * checkout's `prototype/.env`. The check compares canonical paths, so a
 * symlink to a protected path is refused like the path itself. Without an
 * absolute `HOME` every added root is refused, since the home-directory
 * paths cannot be located. The check runs when the turn starts and keeps no
 * directory identity: afterwards the native file tools rely on their own
 * per-call containment checks, and their root anchor is set when a tool first
 * touches the root.
 *
 * The primary workspace is not checked here: this module covers added roots
 * only.
 */

import { lstat, readlink, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdditionalRootRequest,
  type AdmittedAdditionalRoot,
  DomainError,
  MAX_ADDITIONAL_ROOTS,
} from "../../contract/mod.ts";

/**
 * An added root was refused. A refusal of one root names its position, and
 * the refusal of too many roots names the limit; neither names a path.
 */
export class AdditionalRootRefusedError extends DomainError {
  override readonly name = "AdditionalRootRefusedError";
}

/** Where the protected paths are, as the runtime's boundary knows them. */
export interface ProtectedPathInputs {
  /** The operator's home directory. */
  home?: string;
  /** `DYFJ_ROOT`, the config root, when it is set. */
  dyfjRoot?: string;
  /** The runtime checkout's `prototype/` directory. */
  prototypeRoot?: string;
}

/** The runtime's own `prototype/` directory. */
export function runtimePrototypeRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

/**
 * Canonical spellings of the absolute `path`: its realpath when it resolves;
 * otherwise the realpath of the nearest ancestor that resolves, walking the
 * path as written (no lexical `..` folding first, so `link/..` follows the
 * link), with the unresolved rest appended. A dangling symlink on the way
 * also contributes its target's spellings, up to a bounded depth.
 */
async function canonicalForms(path: string, depth = 0): Promise<string[]> {
  try {
    return [await realpath(path)];
  } catch {
    // Not resolvable as a whole: walk up below.
  }
  const forms: string[] = [];
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    if (depth < 8) {
      try {
        if ((await lstat(existing)).isSymbolicLink()) {
          const target = await readlink(existing);
          const absolute = isAbsolute(target)
            ? target
            : `${dirname(existing)}${sep}${target}`;
          const rest = missing.length === 0 ? "" : sep + missing.join(sep);
          forms.push(...await canonicalForms(absolute + rest, depth + 1));
        }
      } catch {
        // Absent: keep walking up.
      }
    }
    const parent = dirname(existing);
    if (parent === existing) return [...forms, resolve(path)];
    missing.unshift(basename(existing));
    existing = parent;
    try {
      return [...forms, join(await realpath(existing), ...missing)];
    } catch {
      // Keep walking up.
    }
  }
}

/** `path` and `child` joined without folding `..` segments. */
function under(path: string, ...children: string[]): string {
  return [path.replace(/[\\/]+$/, ""), ...children].join(sep);
}

/**
 * The protected paths, each in its lexical form and its canonical forms (see
 * `canonicalForms`), so a root that would contain one once it is created is
 * refused too. Throws `AdditionalRootRefusedError` without an absolute
 * `HOME`.
 */
export async function protectedPaths(
  inputs: ProtectedPathInputs,
): Promise<string[]> {
  if (inputs.home === undefined || !isAbsolute(inputs.home)) {
    throw new AdditionalRootRefusedError(
      "Additional roots need an absolute HOME, to locate the paths the " +
        "runtime protects",
    );
  }
  const listed = [
    under(inputs.home, ".dyfj"),
    under(inputs.home, ".dyfj", "runner-homes"),
    under(inputs.home, ".config", "dyfj"),
  ];
  if (
    inputs.dyfjRoot !== undefined && inputs.dyfjRoot !== "" &&
    isAbsolute(inputs.dyfjRoot)
  ) {
    listed.push(inputs.dyfjRoot);
  }
  if (inputs.prototypeRoot !== undefined) {
    listed.push(under(inputs.prototypeRoot, ".env"));
  }
  const resolved = new Set<string>();
  for (const path of listed) {
    resolved.add(resolve(path));
    for (const form of await canonicalForms(path)) resolved.add(form);
  }
  return [...resolved];
}

/** True when `inner` is `outer` or lies inside it. Both are absolute. */
export function pathWithin(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  // A child named `..cache` is inside; only a `..` segment leaves.
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `root` is, sits inside, or contains `guarded`. */
export function overlapsProtectedPath(root: string, guarded: string): boolean {
  return pathWithin(root, guarded) || pathWithin(guarded, root);
}

function rootName(path: string, taken: Set<string>): string {
  const base = basename(path).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * Admit the requested extra roots, or throw `AdditionalRootRefusedError` for
 * the first one that fails. Duplicates and a root equal to the primary
 * workspace are dropped; a duplicate that is read-write in any request is
 * admitted read-write.
 */
export async function admitAdditionalRoots(
  requested: readonly AdditionalRootRequest[],
  options: { primary?: string; protectedPaths: readonly string[] },
): Promise<AdmittedAdditionalRoot[]> {
  if (requested.length > MAX_ADDITIONAL_ROOTS) {
    throw new AdditionalRootRefusedError(
      `At most ${MAX_ADDITIONAL_ROOTS} additional roots are allowed`,
    );
  }
  const primary = options.primary === undefined
    ? undefined
    : (await canonicalForms(options.primary))[0];
  const byPath = new Map<string, boolean>();
  for (const [index, root] of requested.entries()) {
    const position = index + 1;
    if (typeof root.path !== "string" || !isAbsolute(root.path)) {
      throw new AdditionalRootRefusedError(
        `Additional root ${position} must be an absolute path`,
      );
    }
    let real: string;
    try {
      real = await realpath(root.path);
      if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AdditionalRootRefusedError(
        `Additional root ${position} is not an accessible directory`,
      );
    }
    if (options.protectedPaths.some((guarded) => overlapsProtectedPath(real, guarded))) {
      throw new AdditionalRootRefusedError(
        `Additional root ${position} is refused: it is, contains, or sits ` +
          "inside a path the runtime protects (its own directory, its config, " +
          "the Codex runner home, or prototype/.env)",
      );
    }
    if (real === primary) continue;
    const readOnly = root.readOnly === true;
    byPath.set(real, (byPath.get(real) ?? true) && readOnly);
  }
  const taken = new Set<string>();
  return [...byPath].map(([path, readOnly]) => ({
    name: rootName(path, taken),
    path,
    readOnly,
  }));
}
