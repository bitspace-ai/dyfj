/**
 * extensions/friction/ (L4): the operator's friction checkpoint behind the
 * Extension interface (specs/01-architecture.md §6).
 *
 * `createFrictionExtension` builds the `friction` extension, whose one method,
 * `friction/post`, numbers and posts a friction note as a comment on the
 * operator's checkpoint issue (`friction.ts`). It calls Linear only through
 * the commands the linear extension resolved, which arrive in its deps
 * (`linear`), and asks the connected client to approve each call through the
 * deps' `toolApprover`. The instance owns the queue that runs posts one at a
 * time. The interactive REPL imports this directory only through `client.ts`.
 *
 * Allowed dependencies: `kernel/`, `contract/`, `config/`, `store/` (types),
 * `tools/` (types), `transport/`.
 */

import { generateTraceId } from "../../kernel/mod.ts";
import { summarizeError } from "../../contract/mod.ts";
import type { PermissionLevel } from "../../config/mod.ts";
import type { EventInsert } from "../../store/mod.ts";
import type {
  CommandDefinition,
  CommandEventContext,
  CommandPolicyContext,
  ConfirmToolApproval,
} from "../../tools/mod.ts";
import {
  asRecord,
  type RpcContext,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "../../transport/mod.ts";
import {
  FRICTION_SEVERITIES,
  type FrictionContext,
  type FrictionPostInput,
  FrictionStageError,
  postFriction,
  requireFrictionIssueIdentifier,
} from "./friction.ts";

/** What friction needs from the composition root on every request. */
export interface FrictionExtensionDeps {
  /** The Linear commands the linear extension resolved, and their invoker. */
  linear: {
    getIssue?: CommandDefinition;
    listComments?: CommandDefinition;
    createComment?: CommandDefinition;
    invoke(
      command: CommandDefinition,
      arguments_: Record<string, unknown>,
      context: {
        sessionId: string;
        traceId: string;
        writeEvent: CommandEventContext["writeEvent"];
        confirmApproval: ConfirmToolApproval;
        policy: CommandPolicyContext;
      },
    ): Promise<unknown>;
  };
  /** Asks the client behind `ctx` to approve a tool call; fails closed. */
  toolApprover(ctx: RpcContext): ConfirmToolApproval;
}

export interface FrictionExtensionOptions {
  /** The operator's friction-checkpoint issue identifier. */
  issueId?: string;
  /** Wall clock for the comment's date line; the system clock when omitted. */
  now?: () => Date;
  /** Durable writer for friction's tool receipts. */
  writeEvent: (event: EventInsert) => Promise<void> | void;
  /** Operator permission posture for friction's tool calls. */
  permissionLevel: PermissionLevel;
}

export interface FrictionExtension {
  id: "friction";
  rpc(deps: FrictionExtensionDeps): RpcHandlers;
}

export function createFrictionExtension(
  options: FrictionExtensionOptions,
): FrictionExtension {
  // Friction posts run one at a time: each numbers its comment from the
  // issue's existing comments, so two concurrent posts must not interleave.
  let frictionQueue: Promise<void> = Promise.resolve();

  const withFrictionLock = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = frictionQueue.then(run, run);
    frictionQueue = result.then(() => {}, () => {});
    return await result;
  };

  return {
    id: "friction",
    rpc: (deps) => {
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
              options.issueId,
            );
          } catch (error) {
            const message = error instanceof FrictionStageError
              ? error.message
              : `friction/post failed: ${summarizeError(error)}`;
            throw new RpcError(RpcErrorCode.internalError, message);
          }

          const linear = deps.linear;
          const getIssueCommand = linear.getIssue;
          if (getIssueCommand === undefined) {
            throw new RpcError(
              RpcErrorCode.internalError,
              "get_issue failed: configured Linear tool is unavailable",
            );
          }
          const listCommentsCommand = linear.listComments;
          if (listCommentsCommand === undefined) {
            throw new RpcError(
              RpcErrorCode.internalError,
              "list_comments failed: configured Linear tool is unavailable",
            );
          }
          const createCommentCommand = linear.createComment;
          if (createCommentCommand === undefined) {
            throw new RpcError(
              RpcErrorCode.internalError,
              "create_comment/save_comment failed: configured Linear tool is unavailable",
            );
          }
          const traceId = generateTraceId();
          const confirmApproval = deps.toolApprover(ctx);
          const policy = {
            permissionLevel: options.permissionLevel,
            loopback: true,
          } as const;
          const invoke = (
            command: CommandDefinition,
            arguments_: Record<string, unknown>,
          ): Promise<unknown> =>
            linear.invoke(
              command,
              arguments_,
              context?.sessionId === undefined
                ? {
                  sessionId: "friction-unpersisted",
                  traceId,
                  writeEvent: () => {},
                  confirmApproval,
                  policy,
                }
                : {
                  sessionId: context.sessionId,
                  traceId,
                  writeEvent: async (event) => {
                    try {
                      await options.writeEvent(event);
                    } catch (error) {
                      const kind = error instanceof Error
                        ? error.name
                        : "unknown";
                      console.warn(
                        `friction tool receipt write failed (${kind})`,
                      );
                    }
                  },
                  confirmApproval,
                  policy,
                },
            );

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
                now: options.now,
              })
            );
          } catch (error) {
            const message = error instanceof FrictionStageError
              ? error.message
              : `friction/post failed: ${summarizeError(error)}`;
            throw new RpcError(RpcErrorCode.internalError, message);
          }
        },
      };
    },
  };
}
