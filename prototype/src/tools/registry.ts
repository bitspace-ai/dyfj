/**
 * The command registry: commands by id, in registration order, and their
 * projection to the tools a provider is offered.
 */

import type { CommandDefinition, ToolProjection } from "./definition.ts";
import { standardInputSchema } from "./standard-schema.ts";

export interface CommandRegistry {
  register(command: CommandDefinition): void;
  lookup(commandId: string): CommandDefinition | undefined;
  list(): CommandDefinition[];
  projectTools(): ToolProjection[];
}

export function createCommandRegistry(
  commands: CommandDefinition[] = [],
): CommandRegistry {
  const byId = new Map<string, CommandDefinition>();

  const registry: CommandRegistry = {
    register(command) {
      if (byId.has(command.id)) {
        throw new Error(`Command already registered: ${command.id}`);
      }
      byId.set(command.id, command);
    },

    lookup(commandId) {
      return byId.get(commandId);
    },

    list() {
      return [...byId.values()];
    },

    projectTools() {
      return [...byId.values()].map((command) => ({
        name: command.id,
        description: command.description,
        // A provider is a standards boundary: the runtime's own `nullable`
        // keyword never crosses it.
        parameters: standardInputSchema(command.inputSchema),
      }));
    },
  };

  for (const command of commands) {
    registry.register(command);
  }
  return registry;
}
