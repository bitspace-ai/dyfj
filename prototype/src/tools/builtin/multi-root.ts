/**
 * One file tool over the workspace and the session's added roots
 * (`--add-dir`).
 *
 * Each root gets its own instance of the tool, bound to that root's anchor,
 * so every per-call check the tool makes (relative paths only, canonical
 * containment, the root's identity) applies inside the root the call names.
 * This wrapper adds one optional argument, `root`, whose value is an added
 * root's name; without it the call goes to the workspace. A write tool
 * refuses a read-only root before the approval prompt and again in its
 * executor.
 */

import type { AdmittedAdditionalRoot } from "../../contract/mod.ts";
import type { CommandCall, CommandDefinition } from "../definition.ts";

/** The argument that names an added root. */
export const ROOT_ARGUMENT = "root";

/** One added root and the tool instance bound to it. */
export interface RootedCommand {
  root: AdmittedAdditionalRoot;
  command: CommandDefinition;
}

function readOnlyRefusal(name: string): string {
  return `root ${name} is read-only`;
}

/**
 * `primary` extended to `extras`. Returns `primary` unchanged when there are
 * no extras. `writes` marks a tool that changes files.
 */
export function multiRootTool(
  primary: CommandDefinition,
  extras: readonly RootedCommand[],
  writes: boolean,
): CommandDefinition {
  if (extras.length === 0) return primary;
  const byName = new Map(extras.map((extra) => [extra.root.name, extra]));
  const route = (call: CommandCall) => {
    const { [ROOT_ARGUMENT]: name, ...rest } = call.arguments;
    const stripped: CommandCall = { ...call, arguments: rest };
    if (name === undefined) {
      return { command: primary, call: stripped, extra: undefined };
    }
    const extra = typeof name === "string" ? byName.get(name) : undefined;
    if (extra === undefined) {
      // Argument validation checks the enum first; this is the fallback.
      throw new Error("unknown root");
    }
    return { command: extra.command, call: stripped, extra };
  };
  const refusal = (extra: RootedCommand | undefined): string | null =>
    writes && extra?.root.readOnly === true
      ? readOnlyRefusal(extra.root.name)
      : null;
  const names = extras.map((extra) => extra.root.name);
  return {
    ...primary,
    description: `${primary.description} Paths are relative to the workspace ` +
      `root, or to the added root named by \`${ROOT_ARGUMENT}\`.`,
    inputSchema: {
      ...primary.inputSchema,
      properties: {
        ...primary.inputSchema.properties,
        [ROOT_ARGUMENT]: {
          type: "string",
          enum: names,
          description: "An added root to use instead of the workspace. " +
            `Omit it for the workspace.${
              writes ? " A read-only root refuses writes." : ""
            }`,
        },
      },
    },
    approvalTitle: (call) => {
      const routed = route(call);
      const title = routed.command.approvalTitle?.(routed.call) ??
        routed.command.title;
      return routed.extra === undefined
        ? title
        : `${title} (root ${routed.extra.root.name})`;
    },
    ...(primary.readOnlyCall === undefined ? {} : {
      readOnlyCall: (call: CommandCall) => {
        const routed = route(call);
        return routed.command.readOnlyCall?.(routed.call) === true;
      },
    }),
    precheck: async (call) => {
      const routed = route(call);
      return refusal(routed.extra) ??
        (await routed.command.precheck?.(routed.call)) ?? null;
    },
    executor: (call, context) => {
      const routed = route(call);
      const refused = refusal(routed.extra);
      if (refused !== null) return `error: ${refused}`;
      return routed.command.executor(routed.call, context);
    },
  };
}
