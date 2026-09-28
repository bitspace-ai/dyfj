// The `tools` namespace: the tool catalog a turn in a given workspace would
// see, projected to its public summary. Listing never executes a tool.

import { buildToolCatalog, type CommandDefinition } from "../../tools/mod.ts";
import {
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import { asRecord } from "./params.ts";

export interface WorkbenchToolSummary {
  id: string;
  title: string;
  description: string;
  inputSchema: CommandDefinition["inputSchema"];
  permission: CommandDefinition["permission"];
  redactResult: boolean;
}

export interface ToolsHandlerDeps {
  /** Boot-discovered external MCP commands available to this runtime. */
  externalMcpCommands?: readonly CommandDefinition[];
}

function projectCommand(command: CommandDefinition): WorkbenchToolSummary {
  return {
    id: command.id,
    title: command.title,
    description: command.description,
    inputSchema: command.inputSchema,
    permission: command.permission,
    redactResult: command.redactResult === true,
  };
}

export function listToolCatalog(
  params: unknown,
  externalMcpCommands: readonly CommandDefinition[] = [],
): WorkbenchToolSummary[] {
  const record = asRecord(params);
  const workspaceRoot = typeof record.workspace === "string"
    ? record.workspace
    : undefined;
  return buildToolCatalog({}, { workspaceRoot }, externalMcpCommands)
    .list()
    .map(projectCommand);
}

export function buildToolsHandlers(deps: ToolsHandlerDeps): RpcHandlers {
  return {
    "tools/list": async (params) => ({
      tools: listToolCatalog(params, deps.externalMcpCommands),
    }),

    "tools/inspect": async (params) => {
      const record = asRecord(params);
      const commandId = record.commandId ?? record.id;
      if (typeof commandId !== "string") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "tools/inspect requires a string commandId",
        );
      }
      const tool = listToolCatalog(params, deps.externalMcpCommands).find((
        candidate,
      ) => candidate.id === commandId);
      if (tool === undefined) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `unknown tool: ${commandId}`,
        );
      }
      return { tool };
    },
  };
}
