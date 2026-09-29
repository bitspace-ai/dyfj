/**
 * extensions/linear/ (L4): the Linear integration behind the Extension
 * interface (specs/01-architecture.md §6).
 *
 * Two pieces, each handed out by the composition root:
 * - `buildLinearIssueCreationCommand` is the MCP discovery port that builds the
 *   bounded `create_issue` command (`linear-tools.ts`) for a server with an
 *   operator issue-creation binding. It needs the discovered schema, so it
 *   runs during discovery rather than as an extension's `commands`.
 * - `createLinearExtension` resolves, once, the Linear MCP commands other
 *   extensions call (`get_issue`, `list_comments`, and `create_comment` or
 *   `save_comment`) from the discovered commands, and invokes them through
 *   one registry of exactly those commands under the call-shape policy, each
 *   call receipted as a `tool_call` event. Friction reaches them through
 *   `ExtensionDeps.linear`.
 *
 * Allowed dependencies: `config/`, `tools/`.
 */

import type {
  LinearIssueCreationBinding,
  McpHttpServerConfig,
} from "../../config/mod.ts";
import {
  buildToolCatalog,
  type CommandDefinition,
  type CommandEventContext,
  type CommandPolicyContext,
  type ConfirmToolApproval,
  invokeCommandWithEvent,
} from "../../tools/mod.ts";
import {
  buildBoundedLinearCreateIssueCommand,
  type LinearCreationUpstreamTool,
  type LinearIssueMcpCall,
  projectLinearCreationUpstreamSchema,
} from "./linear-tools.ts";

export const LINEAR_COMMENT_UPSTREAM_TOOLS = [
  "create_comment",
  "save_comment",
] as const;

export function isLinearCommentCommandId(id: string): boolean {
  return LINEAR_COMMENT_UPSTREAM_TOOLS.some((tool) =>
    id === `mcp.linear.${tool}`
  );
}

/**
 * The discovery port: the bounded issue-creation command for a configured
 * `create_issue`/`save_issue` tool, or `undefined` when the discovered schema
 * is unsupported.
 */
export function buildLinearIssueCreationCommand(input: {
  server: McpHttpServerConfig;
  binding: LinearIssueCreationBinding;
  token: string;
  revision: string;
  discoveredSchema: unknown;
  upstreamTool: LinearCreationUpstreamTool;
  call: LinearIssueMcpCall;
}): CommandDefinition<string> | undefined {
  const upstreamSchema = projectLinearCreationUpstreamSchema(
    input.discoveredSchema,
    input.binding,
  );
  if (upstreamSchema === undefined) return undefined;
  return buildBoundedLinearCreateIssueCommand({
    server: input.server,
    binding: input.binding,
    token: input.token,
    revision: input.revision,
    upstreamSchema,
    upstreamTool: input.upstreamTool,
    call: input.call,
  });
}

/** How one Linear command call is authorized and receipted. */
export interface LinearCallContext {
  /** The session the receipt belongs to. */
  sessionId: string;
  traceId: string;
  writeEvent: CommandEventContext["writeEvent"];
  confirmApproval: ConfirmToolApproval;
  policy: CommandPolicyContext;
}

/** The Linear MCP commands other extensions call; absent when not discovered. */
export interface LinearCommands {
  getIssue?: CommandDefinition;
  listComments?: CommandDefinition;
  createComment?: CommandDefinition;
  /**
   * Invoke one of the commands above as the operator. Resolves to the
   * command's result; a denied or failed call rejects with its reason.
   */
  invoke(
    command: CommandDefinition,
    arguments_: Record<string, unknown>,
    context: LinearCallContext,
  ): Promise<unknown>;
}

export interface LinearExtension {
  id: "linear";
  linear: LinearCommands;
}

export function createLinearExtension(
  externalCommands: readonly CommandDefinition[],
): LinearExtension {
  const getIssue = externalCommands.find((command) =>
    command.id === "mcp.linear.get_issue"
  );
  const listComments = externalCommands.find((command) =>
    command.id === "mcp.linear.list_comments"
  );
  const createComment = externalCommands.find((command) =>
    isLinearCommentCommandId(command.id)
  );
  // Only these Linear commands: no builtin tools.
  const registry = buildToolCatalog(
    {},
    {},
    [getIssue, listComments, createComment].filter(
      (command): command is CommandDefinition => command !== undefined,
    ),
    [],
  );
  return {
    id: "linear",
    linear: {
      ...(getIssue === undefined ? {} : { getIssue }),
      ...(listComments === undefined ? {} : { listComments }),
      ...(createComment === undefined ? {} : { createComment }),
      async invoke(command, arguments_, context) {
        const call = {
          commandId: command.id,
          callId: crypto.randomUUID(),
          caller: {
            principalId: "operator",
            principalType: "human" as const,
          },
          arguments: arguments_,
        };
        const result = await invokeCommandWithEvent(
          registry,
          call,
          {
            sessionId: context.sessionId,
            traceId: context.traceId,
            writeEvent: context.writeEvent,
          },
          context.confirmApproval,
          context.policy,
        );
        if (result.isError) throw new Error(result.reason);
        return result.result;
      },
    },
  };
}
