/**
 * extensions/ideas/ (L4): idea marking and Work Packet drafting behind the
 * Extension interface (specs/01-architecture.md §6).
 *
 * `createIdeaPacketExtensions` builds the two extensions this directory
 * serves over one `IdeaPacketRegistry` that the pair owns:
 * - `ideas`: `ideas/mark`, `ideas/list`, `ideas/get`;
 * - `packets`: `packets/draft`, `packets/list`, `packets/get`.
 *
 * Ideas and packets share the registry because a packet references its idea
 * and eviction crosses the two. The server composition root builds one pair
 * per engine; the registry lives in memory for that engine's life. The
 * interactive REPL imports this directory only through `client.ts`.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `transport/`. Session events
 * and workspaces are read through the readers the deps carry, never by
 * importing `store/` or `server/`.
 */

import {
  summarizeError,
  type WorkbenchSessionEvent,
} from "../../contract/mod.ts";
import {
  asRecord,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "../../transport/mod.ts";
import {
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  IdeaPacketRegistry,
  markWorkbenchIdea,
} from "./idea-packet.ts";

/** The session readers the idea and packet methods use. */
export interface IdeaPacketExtensionDeps {
  fetchSessionEvents(
    input: { sessionId: string; eventId?: string; limit?: number },
  ): Promise<WorkbenchSessionEvent[]>;
  fetchSessionWorkspaceRecord(
    input: { sessionId: string },
  ): Promise<{ exists: boolean; workspace: string | null }>;
}

export interface IdeaPacketExtension {
  id: "ideas" | "packets";
  rpc(deps: IdeaPacketExtensionDeps): RpcHandlers;
}

/** The `ideas` and `packets` extensions, sharing one owned registry. */
export function createIdeaPacketExtensions(): [
  IdeaPacketExtension,
  IdeaPacketExtension,
] {
  const registry = new IdeaPacketRegistry();
  return [
    { id: "ideas", rpc: (deps) => buildIdeasHandlers(deps, registry) },
    { id: "packets", rpc: (deps) => buildPacketsHandlers(deps, registry) },
  ];
}

function buildIdeasHandlers(
  deps: IdeaPacketExtensionDeps,
  registry: IdeaPacketRegistry,
): RpcHandlers {
  return {
    "ideas/mark": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const label = sanitizeRpcString(record.label, "label", {
        required: true,
        maxLen: 256,
      })!;
      const eventId = sanitizeRpcIdentifier(record.eventId, "eventId", {
        maxLen: 256,
      });
      const description = sanitizeRpcString(
        record.description,
        "description",
        { maxLen: 2000, singleLine: false },
      );
      let events: WorkbenchSessionEvent[] | undefined;
      try {
        events = eventId
          ? await deps.fetchSessionEvents({ sessionId, eventId })
          : await deps.fetchSessionEvents({ sessionId, limit: 20 });
      } catch (e) {
        if (eventId) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            summarizeError(e),
          );
        }
        events = undefined;
      }
      try {
        const idea = markWorkbenchIdea({
          sessionId,
          label,
          eventId,
          description,
          events,
          registry,
        });
        return { idea };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "ideas/list": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      try {
        return { ideas: registry.listIdeas(sessionId) };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "ideas/get": async (params) => {
      const record = asRecord(params);
      const ideaId = sanitizeRpcIdentifier(record.ideaId, "ideaId", {
        required: true,
        maxLen: 256,
      })!;
      try {
        const idea = registry.getIdea(ideaId);
        return { idea };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },
  };
}

function buildPacketsHandlers(
  deps: IdeaPacketExtensionDeps,
  registry: IdeaPacketRegistry,
): RpcHandlers {
  return {
    "packets/draft": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const ideaId = sanitizeRpcIdentifier(record.ideaId, "ideaId", {
        maxLen: 256,
      });
      const eventId = sanitizeRpcIdentifier(record.eventId, "eventId", {
        maxLen: 256,
      });
      if (ideaId && eventId) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "packets/draft cannot specify both ideaId and eventId",
        );
      }
      const issueId = sanitizeRpcIdentifier(record.issueId, "issueId", {
        maxLen: 256,
      });
      const title = sanitizeRpcString(record.title, "title", { maxLen: 256 });
      const operatorIntent = sanitizeRpcString(
        record.operatorIntent,
        "operatorIntent",
        { maxLen: 2000, singleLine: false },
      );
      const idea = ideaId ? registry.getIdea(ideaId) : null;
      if (ideaId && !idea) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `idea "${ideaId}" not found`,
        );
      }
      if (idea && idea.sessionId !== sessionId) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `idea "${ideaId}" belongs to session "${idea.sessionId}", not requested session "${sessionId}"`,
        );
      }
      const referencedEventId = eventId ?? idea?.eventId ?? undefined;
      let events: WorkbenchSessionEvent[] | undefined;
      try {
        events = referencedEventId
          ? await deps.fetchSessionEvents({
            sessionId,
            eventId: referencedEventId,
          })
          : await deps.fetchSessionEvents({ sessionId, limit: 50 });
      } catch (e) {
        if (referencedEventId) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            summarizeError(e),
          );
        }
        events = undefined;
      }
      let workspace: string | null = null;
      try {
        const workspaceRec = await deps.fetchSessionWorkspaceRecord({
          sessionId,
        });
        workspace = workspaceRec.workspace;
      } catch {
        workspace = null;
      }
      try {
        const packet = draftWorkPacketFromContext({
          sessionId,
          idea,
          ideaId,
          eventId,
          issueId,
          title,
          operatorIntent,
          events,
          workspace,
          registry,
        });
        const markdown = formatWorkPacketMarkdown(packet);
        return { packet, markdown };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "packets/list": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      try {
        return { packets: registry.listPackets(sessionId) };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

    "packets/get": async (params) => {
      const record = asRecord(params);
      const packetId = sanitizeRpcIdentifier(record.packetId, "packetId", {
        required: true,
        maxLen: 256,
      })!;
      try {
        const packet = registry.getPacket(packetId);
        const markdown = packet ? formatWorkPacketMarkdown(packet) : null;
        return { packet, markdown };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },
  };
}
