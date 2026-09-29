/**
 * The Extension interface (specs/01-architecture.md §6): how optional
 * features plug into the engine server without the core importing them.
 *
 * An extension is a plain object built by its own factory in the composition
 * root (`main.ts`), which holds the static list; there is no dynamic loading.
 * Any state an extension keeps (the idea/packet registry, for example) is
 * owned by that instance, never by a module-level singleton. Extensions live
 * under `extensions/<id>/` and do not import `server/`: each declares the
 * deps it needs and returns handlers of the transport's `RpcHandlers` shape,
 * so it satisfies this interface structurally.
 *
 * Allowed dependencies: `transport/` (types), the RPC readers' types.
 */

import type { RpcHandlers } from "../transport/mod.ts";
import type { FetchSessionEvents } from "./rpc/events.ts";
import type { FetchSessionWorkspaceRecord } from "./rpc/sessions.ts";

/** What the composition root hands every extension. */
export interface ExtensionDeps {
  fetchSessionEvents: FetchSessionEvents;
  fetchSessionWorkspaceRecord: FetchSessionWorkspaceRecord;
}

export interface Extension {
  /** The feature id: "ideas", "packets", "friction" or "linear". */
  id: string;
  /** The extension's JSON-RPC methods, keyed by method name. */
  rpc?(deps: ExtensionDeps): RpcHandlers;
}

/**
 * Merge every extension's methods into one handler map. Two extensions (or an
 * extension and itself) claiming the same method name is a composition error.
 */
export function buildExtensionHandlers(
  extensions: readonly Extension[],
  deps: ExtensionDeps,
): RpcHandlers {
  const handlers: RpcHandlers = {};
  const ids = new Set<string>();
  for (const extension of extensions) {
    if (ids.has(extension.id)) {
      throw new Error(`duplicate extension id: ${extension.id}`);
    }
    ids.add(extension.id);
    for (
      const [method, handler] of Object.entries(extension.rpc?.(deps) ?? {})
    ) {
      if (Object.hasOwn(handlers, method)) {
        throw new Error(
          `extension ${extension.id} redefines RPC method ${method}`,
        );
      }
      handlers[method] = handler;
    }
  }
  return handlers;
}
