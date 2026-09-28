// The extension methods that have not moved behind the Extension interface
// yet: `friction/post`, `ideas/*` and `packets/*`. They stay together here,
// unchanged, until the extension layer (specs/01-architecture.md §6) gives
// each its own module; this file is then deleted.

import { generateTraceId } from "../../kernel/mod.ts";
import type { PermissionLevel, WorkbenchConfig } from "../../config/mod.ts";
import {
  summarizeError,
  type WorkbenchSessionEvent,
} from "../../contract/mod.ts";
import {
  defaultIdeaPacketRegistry,
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  type IdeaPacketRegistry,
  markWorkbenchIdea,
} from "../../idea-packet.ts";
import {
  FRICTION_SEVERITIES,
  type FrictionContext,
  type FrictionPostInput,
  FrictionStageError,
  isLinearCommentCommandId,
  postFriction,
  requireFrictionIssueIdentifier,
} from "../../friction.ts";
import type { EventInsert } from "../../store/mod.ts";
import {
  buildToolCatalog,
  type CommandDefinition,
  type ConfirmToolApproval,
  invokeCommandWithEvent,
} from "../../tools/mod.ts";
import {
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import { toApprovalVerdict } from "./approval.ts";
import type { FetchSessionEvents } from "./events.ts";
import {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./params.ts";
import type { FetchSessionWorkspaceRecord } from "./sessions.ts";

export interface LegacyExtensionHandlerDeps {
  fetchSessionEvents: FetchSessionEvents;
  fetchSessionWorkspaceRecord: FetchSessionWorkspaceRecord;
  /** Boot-discovered external MCP commands; friction uses the Linear ones. */
  externalMcpCommands?: readonly CommandDefinition[];
  /** Configured operator friction-checkpoint issue identifier. */
  frictionIssueId?: string;
  /** Wall clock for friction receipts; the friction default when omitted. */
  frictionNow?: () => Date;
  /** Durable writer for friction's tool receipts. */
  frictionEventWriter: (event: EventInsert) => Promise<void> | void;
  /** Operator permission posture for friction's tool calls. */
  engineConfig?: Pick<WorkbenchConfig, "permissionLevel">;
  permissionLevel?: PermissionLevel;
  /** Idea/packet registry; the process-wide default when omitted. */
  ideaPacketRegistry?: IdeaPacketRegistry;
}

export function buildLegacyExtensionHandlers(
  deps: LegacyExtensionHandlerDeps,
): RpcHandlers {
  // Friction posts run one at a time: each numbers its comment from the
  // issue's existing comments, so two concurrent posts must not interleave.
  let frictionQueue: Promise<void> = Promise.resolve();

  const withFrictionLock = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = frictionQueue.then(run, run);
    frictionQueue = result.then(() => {}, () => {});
    return await result;
  };

  return {
    "friction/post": async (params, ctx) => {
      const record = asRecord(params);
      const severity = sanitizeRpcString(record.severity, "severity", {
        required: true,
        maxLen: 16,
      });
      if (
        !FRICTION_SEVERITIES.includes(
          severity as (typeof FRICTION_SEVERITIES)[number],
        )
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `severity must be one of: ${FRICTION_SEVERITIES.join(", ")}`,
        );
      }
      if (typeof record.escaped !== "boolean") {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "escaped must be a boolean",
        );
      }
      const text = sanitizeRpcString(record.text, "text", {
        required: true,
        maxLen: 32_768,
        singleLine: false,
      })!;
      let context: FrictionContext | undefined;
      if (record.context !== undefined) {
        if (
          typeof record.context !== "object" || record.context === null ||
          Array.isArray(record.context)
        ) {
          throw new RpcError(
            RpcErrorCode.invalidParams,
            "context must be an object",
          );
        }
        const rawContext = record.context as Record<string, unknown>;
        const sessionId = sanitizeRpcIdentifier(
          rawContext.sessionId,
          "context.sessionId",
          { maxLen: 256 },
        );
        const model = sanitizeRpcString(rawContext.model, "context.model", {
          maxLen: 256,
        });
        const workspace = sanitizeRpcString(
          rawContext.workspace,
          "context.workspace",
          { maxLen: 4096 },
        );
        const command = sanitizeRpcString(
          rawContext.command,
          "context.command",
          { maxLen: 32_768 },
        );
        context = {
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(model === undefined ? {} : { model }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(command === undefined ? {} : { command }),
        };
      }

      let issueIdentifier: string;
      try {
        issueIdentifier = requireFrictionIssueIdentifier(
          deps.frictionIssueId,
        );
      } catch (error) {
        const message = error instanceof FrictionStageError
          ? error.message
          : `friction/post failed: ${summarizeError(error)}`;
        throw new RpcError(RpcErrorCode.internalError, message);
      }

      const externalCommands = deps.externalMcpCommands ?? [];
      const getIssueCommand = externalCommands.find((command) =>
        command.id === "mcp.linear.get_issue"
      );
      if (getIssueCommand === undefined) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "get_issue failed: configured Linear tool is unavailable",
        );
      }
      const listCommentsCommand = externalCommands.find((command) =>
        command.id === "mcp.linear.list_comments"
      );
      if (listCommentsCommand === undefined) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "list_comments failed: configured Linear tool is unavailable",
        );
      }
      const createCommentCommand = externalCommands.find((command) =>
        isLinearCommentCommandId(command.id)
      );
      if (createCommentCommand === undefined) {
        throw new RpcError(
          RpcErrorCode.internalError,
          "create_comment/save_comment failed: configured Linear tool is unavailable",
        );
      }
      // Only the three Linear commands friction invokes: no builtin tools.
      const registry = buildToolCatalog({}, {}, [
        getIssueCommand,
        listCommentsCommand,
        createCommentCommand,
      ], []);
      const traceId = generateTraceId();
      const invoke = async (
        command: CommandDefinition,
        arguments_: Record<string, unknown>,
      ): Promise<unknown> => {
        const call = {
          commandId: command.id,
          callId: crypto.randomUUID(),
          caller: {
            principalId: "operator",
            principalType: "human" as const,
          },
          arguments: arguments_,
        };
        const confirmApproval: ConfirmToolApproval = (request) =>
          ctx.request("approval", request).then(
            toApprovalVerdict,
            () => ({
              decision: "deny" as const,
              reason: "approval request failed (no client approver?)",
            }),
          );
        const policyContext = {
          permissionLevel: deps.engineConfig?.permissionLevel ??
            deps.permissionLevel ?? "strict",
          loopback: true,
        } as const;
        const result = context?.sessionId === undefined
          ? await invokeCommandWithEvent(
            registry,
            call,
            {
              sessionId: "friction-unpersisted",
              traceId,
              writeEvent: () => {},
            },
            confirmApproval,
            policyContext,
          )
          : await invokeCommandWithEvent(
            registry,
            call,
            {
              sessionId: context.sessionId,
              traceId,
              writeEvent: async (event) => {
                try {
                  await deps.frictionEventWriter(event);
                } catch (error) {
                  const kind = error instanceof Error ? error.name : "unknown";
                  console.warn(`friction tool receipt write failed (${kind})`);
                }
              },
            },
            confirmApproval,
            policyContext,
          );
        if (result.isError) throw new Error(result.reason);
        return result.result;
      };

      try {
        return await withFrictionLock(() =>
          postFriction({
            issueIdentifier,
            request: {
              severity: severity as FrictionPostInput["severity"],
              escaped: record.escaped as boolean,
              text,
              ...(context === undefined ? {} : { context }),
            },
            getIssueCommand,
            listCommentsCommand,
            createCommentCommand,
            invoke: {
              getIssue: (arguments_) => invoke(getIssueCommand, arguments_),
              listComments: (arguments_) =>
                invoke(listCommentsCommand, arguments_),
              createComment: (arguments_) =>
                invoke(createCommentCommand, arguments_),
            },
            now: deps.frictionNow,
          })
        );
      } catch (error) {
        const message = error instanceof FrictionStageError
          ? error.message
          : `friction/post failed: ${summarizeError(error)}`;
        throw new RpcError(RpcErrorCode.internalError, message);
      }
    },

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
          registry: deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry,
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
      const reg = deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        return { ideas: reg.listIdeas(sessionId) };
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
      const reg = deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        const idea = reg.getIdea(ideaId);
        return { idea };
      } catch (e) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          summarizeError(e),
        );
      }
    },

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
      const reg = deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      const idea = ideaId ? reg.getIdea(ideaId) : null;
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
          registry: reg,
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
      const reg = deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        return { packets: reg.listPackets(sessionId) };
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
      const reg = deps.ideaPacketRegistry ?? defaultIdeaPacketRegistry;
      try {
        const packet = reg.getPacket(packetId);
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
