import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DomainError } from "./contract/mod.ts";

/**
 * The pinned adapter's package directory. npm hoists it to the workspace
 * root's node_modules and nests a copy in the member's own only when it must,
 * so the member's is tried first, as Node resolves it. The lookup stops at
 * the workspace root, the member's parent: a node_modules above the checkout
 * is never consulted.
 */
export async function codexAcpPackageRoot(
  prototypeRoot: string,
): Promise<string> {
  for (const base of [prototypeRoot, dirname(prototypeRoot)]) {
    const packageRoot = join(
      base,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
    );
    try {
      await stat(join(packageRoot, "package.json"));
      return packageRoot;
    } catch {
      // Not installed at this level; try the workspace root.
    }
  }
  throw new DomainError("Pinned Codex ACP package is unavailable");
}
