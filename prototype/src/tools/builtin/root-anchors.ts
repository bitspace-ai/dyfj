/**
 * The workspace root's identity, anchored on first use and verified on every
 * subsequent one.
 *
 * Every executor used to re-canonicalize the root PATHNAME per call and trust
 * whatever it resolved to — so renaming the workspace directory away and
 * placing another directory (or a symlink) at the same path silently redefined
 * the auto-approved read boundary: the replacement became the root, and the
 * search tools would recursively enumerate and read it without a prompt. The
 * anchor pins the canonical path and, where the platform reports it, the
 * directory's (dev, ino) identity, the first time a tool touches the root;
 * every later call re-resolves and must match or fails closed with a path-free
 * error. First use is when trust begins — a replacement before any tool has
 * run is indistinguishable from configuration — and the verify-then-use gap is
 * narrowed, not closed, like every other pathname race in the file tools. On
 * platforms reporting null dev/ino the anchor holds the canonical path alone,
 * a weaker pin, stated rather than hidden.
 *
 * `RootAnchors` is the single owner of those anchors. The composition root
 * builds one per engine and hands it to every turn, so an anchor lasts as
 * long as the engine process, whichever turn first touched the root.
 */

import { resolve } from "node:path";

/** The anchored workspace root no longer matches what the path resolves to. */
export class WorkspaceRootChangedError extends Error {
  constructor() {
    super("workspace root identity changed; refusing to proceed");
    this.name = "WorkspaceRootChangedError";
  }
}

interface RootAnchor {
  real: string;
  dev: number | null;
  ino: number | null;
}

/** A workspace root path bound to the anchors that verify it. */
export interface WorkspaceRoot {
  readonly path: string;
  /** The root's canonical path, after checking it against its anchor. */
  verify(): Promise<string>;
}

export class RootAnchors {
  readonly #anchors = new Map<string, RootAnchor>();

  /** Anchor `root` on its first use, then verify it against that anchor. */
  async verify(root: string): Promise<string> {
    const key = resolve(root);
    const real = await Deno.realPath(key);
    const info = await Deno.lstat(real);
    const anchor = this.#anchors.get(key);
    if (anchor === undefined) {
      this.#anchors.set(key, { real, dev: info.dev, ino: info.ino });
      return real;
    }
    const identityHolds = anchor.dev === null || anchor.ino === null
      ? anchor.real === real
      : anchor.real === real && anchor.dev === info.dev &&
        anchor.ino === info.ino;
    if (!identityHolds) {
      throw new WorkspaceRootChangedError();
    }
    return real;
  }

  /** `path` bound to these anchors, for the file tools rooted there. */
  root(path: string): WorkspaceRoot {
    return { path, verify: () => this.verify(path) };
  }
}
