/**
 * The coordinator dispatch tools (BIT-907): `dispatch/start`, `dispatch/wait`,
 * `dispatch/read` and `dispatch/send`.
 *
 * Registered only when `[dispatch]` is configured and the session's dispatch
 * depth is 0. A child session runs at fixed depth 1 with none of these tools,
 * so it cannot start grandchildren.
 */

import path from "node:path";
import {
  type CommandCall,
  type CommandDefinition,
  CommandExecutionError,
} from "../definition.ts";
import {
  DISPATCH_LABEL_PATTERN,
  DISPATCH_LABEL_SCHEMA_PATTERN,
  DISPATCH_REASONING_EFFORTS,
  type DispatchReasoningEffort,
  type DispatchReadResult,
  type DispatchSendResult,
  type DispatchSessionPorts,
  type DispatchStartInput,
  type DispatchStartPlan,
  type DispatchStartResult,
  DISPATCH_TASK_APPROVAL_PREVIEW_CHARS,
  type DispatchWaitResult,
  formatDispatchReadResult,
  MAX_DISPATCH_READ_TURNS,
  MAX_DISPATCH_ROOTS,
  MAX_DISPATCH_TASK_BYTES,
} from "./dispatch-envelope.ts";

export * from "./dispatch-envelope.ts";

/**
 * Whether `text` is longer than `maxBytes` in UTF-8. A UTF-16 code unit encodes
 * to at least one UTF-8 byte, so text with more code units than `maxBytes` is
 * refused without encoding it, and any encoding done is bounded by the limit.
 */
function exceedsUtf8Limit(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  return new TextEncoder().encode(text).byteLength > maxBytes;
}

function parseStartInput(
  call: CommandCall,
): { input: DispatchStartInput } | { refusal: string } {
  const label = call.arguments["label"];
  const task = call.arguments["task"];
  const model = call.arguments["model"];
  const effort = call.arguments["effort"];
  const workspace = call.arguments["workspace"];
  const roots = call.arguments["roots"];
  const approvePaid = call.arguments["approvePaid"];

  if (typeof label !== "string" || !DISPATCH_LABEL_PATTERN.test(label)) {
    return { refusal: "label must match ^[a-z0-9][a-z0-9-]{0,31}$" };
  }
  if (typeof task !== "string") {
    return { refusal: "task must be a string" };
  }
  if (exceedsUtf8Limit(task, MAX_DISPATCH_TASK_BYTES)) {
    return {
      refusal: `task exceeds the ${MAX_DISPATCH_TASK_BYTES}-byte (32 KiB) limit`,
    };
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    return { refusal: "model must be a non-empty model slug" };
  }
  if (
    effort !== undefined &&
    (typeof effort !== "string" ||
      !(DISPATCH_REASONING_EFFORTS as readonly string[]).includes(effort))
  ) {
    return {
      refusal: `effort must be one of ${DISPATCH_REASONING_EFFORTS.join(", ")}`,
    };
  }
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    return { refusal: "workspace must be an absolute path" };
  }
  let parsedRoots: readonly string[] | undefined;
  if (roots !== undefined) {
    if (!Array.isArray(roots) || roots.length > MAX_DISPATCH_ROOTS) {
      return {
        refusal: `roots must be an array of at most ${MAX_DISPATCH_ROOTS} absolute paths`,
      };
    }
    for (const entry of roots) {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) {
        return { refusal: "each entry in roots must be an absolute path" };
      }
    }
    parsedRoots = roots as string[];
  }
  if (approvePaid !== undefined && typeof approvePaid !== "boolean") {
    return { refusal: "approvePaid must be a boolean" };
  }

  return {
    input: {
      label,
      task,
      model: model.trim(),
      ...(effort === undefined
        ? {}
        : { effort: effort as DispatchReasoningEffort }),
      workspace,
      ...(parsedRoots === undefined ? {} : { roots: parsedRoots }),
      approvePaid: approvePaid === true,
    },
  };
}

function defineDispatchStart(
  ports: DispatchSessionPorts,
): CommandDefinition<DispatchStartResult> {
  // The plan the precheck resolved, and the plan the operator was shown. The
  // executor launches only if a fresh resolution still equals the shown plan.
  const cachedPlans = new WeakMap<CommandCall, DispatchStartPlan>();
  const approvedPlans = new WeakMap<CommandCall, DispatchStartPlan>();
  return {
    id: "dispatch/start",
    title: "Start a child session",
    description:
      "Start one child session in an allowed workspace root and run its first " +
      "turn in the background. Asks the operator every time and is never " +
      "granted for a session. The child runs under the parking approver with " +
      "no dispatch tools of its own.",
    inputSchema: {
      type: "object",
      required: ["label", "task", "model", "workspace"],
      properties: {
        label: {
          type: "string",
          pattern: DISPATCH_LABEL_SCHEMA_PATTERN,
          description:
            "Unique label among this coordinator's live children (^[a-z0-9][a-z0-9-]{0,31}$).",
        },
        task: {
          type: "string",
          description:
            "First turn instructions for the child (at most 32 KiB UTF-8), delivered inside a coordinator-message envelope.",
        },
        model: {
          type: "string",
          description: "Active catalog model slug for the child session.",
        },
        effort: {
          type: "string",
          enum: [...DISPATCH_REASONING_EFFORTS],
          description:
            "Optional reasoning effort (low, medium, high, xhigh); omit for the model default.",
        },
        workspace: {
          type: "string",
          description:
            "Absolute path to an existing directory inside one of [dispatch].roots.",
        },
        roots: {
          type: "array",
          maxItems: MAX_DISPATCH_ROOTS,
          items: { type: "string" },
          description:
            "Optional extra absolute directory paths (at most 4), each inside [dispatch].roots.",
        },
        approvePaid: {
          type: "boolean",
          description:
            "Default false. Must be true when starting a paid model; the child never inherits the coordinator's paid posture.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process", "write.filesystem", "emit.event"],
      defaultDecision: "ask",
      resources: ["dispatch:child"],
      // The child's turns may call a remote provider. Prompting on every call
      // comes from `defaultDecision: "ask"`: every auto-allow path in the
      // policy requires `defaultDecision: "allow"`.
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    approvalTitle: (call) => {
      const label = typeof call.arguments["label"] === "string"
        ? call.arguments["label"]
        : "child";
      return `Start child session ${label}`;
    },
    precheck: async (call) => {
      if (ports.depth !== 0) {
        return "dispatch/start is unavailable in a child session";
      }
      const parsed = parseStartInput(call);
      if ("refusal" in parsed) {
        return `dispatch/start refused: ${parsed.refusal}`;
      }
      const checked = await ports.checkStart(parsed.input);
      if ("refusal" in checked) {
        return `dispatch/start refused: ${checked.refusal}`;
      }
      cachedPlans.set(call, checked.plan);
      return null;
    },
    approvalArguments: async (call) => {
      const parsed = parseStartInput(call);
      if ("refusal" in parsed) return call.arguments;
      let plan = cachedPlans.get(call);
      if (plan === undefined) {
        const checked = await ports.checkStart(parsed.input);
        if ("plan" in checked) plan = checked.plan;
      }
      const taskPreview = parsed.input.task.slice(
        0,
        DISPATCH_TASK_APPROVAL_PREVIEW_CHARS,
      );
      if (plan !== undefined) approvedPlans.set(call, plan);
      if (plan === undefined) {
        return {
          label: parsed.input.label,
          model: parsed.input.model,
          effort: parsed.input.effort ?? null,
          workspace: parsed.input.workspace,
          task: taskPreview,
        };
      }
      return {
        label: plan.label,
        model: plan.model,
        effort: plan.effort,
        route: plan.route,
        family: plan.family,
        workspace: plan.workspace,
        ...(plan.roots.length > 0 ? { roots: [...plan.roots] } : {}),
        task: taskPreview,
      };
    },
    executor: async (call) => {
      if (ports.depth !== 0) {
        throw new CommandExecutionError(
          "dispatch/start is unavailable in a child session",
        );
      }
      const parsed = parseStartInput(call);
      if ("refusal" in parsed) {
        throw new CommandExecutionError(
          `dispatch/start refused: ${parsed.refusal}`,
        );
      }
      const approved = approvedPlans.get(call);
      if (approved === undefined) {
        throw new CommandExecutionError(
          "dispatch/start refused: no approved launch plan for this call",
        );
      }
      return await ports.start(parsed.input, approved);
    },
  };
}

function defineDispatchWait(
  ports: DispatchSessionPorts,
): CommandDefinition<DispatchWaitResult> {
  return {
    id: "dispatch/wait",
    title: "Wait for child sessions",
    description:
      'Block until one (`mode: "any"`) or all (`mode: "all"`) named child ' +
      "sessions settle (`awaiting_approval`, `idle`, `failed`, or `cancelled`), " +
      "or until `timeoutSeconds` elapses.",
    inputSchema: {
      type: "object",
      required: ["timeoutSeconds"],
      properties: {
        children: {
          anyOf: [
            { type: "string", enum: ["all"] },
            {
              type: "array",
              maxItems: 32,
              items: {
                type: "string",
                pattern: DISPATCH_LABEL_SCHEMA_PATTERN,
              },
            },
          ],
          description:
            'Child labels to watch, or "all" (default "all"). Only this coordinator\'s children.',
        },
        mode: {
          type: "string",
          enum: ["any", "all"],
          description:
            'Settle when "any" child settles (default) or when "all" watched children settle.',
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: ports.config.maxWaitSeconds,
          description:
            `Wait bound in seconds (1 to ${ports.config.maxWaitSeconds}).`,
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["emit.event"],
      defaultDecision: "allow",
      resources: ["dispatch:child"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: async (call) => {
      const rawChildren = call.arguments["children"] ?? "all";
      if (
        rawChildren !== "all" &&
        (!Array.isArray(rawChildren) || rawChildren.length === 0)
      ) {
        throw new CommandExecutionError(
          'dispatch/wait refused: children must be "all" or a non-empty list of child labels',
        );
      }
      const children: "all" | readonly string[] = rawChildren === "all"
        ? "all"
        : (rawChildren as string[]);
      const mode = call.arguments["mode"] === "all" ? "all" : "any";
      const timeoutSeconds = call.arguments["timeoutSeconds"];
      if (
        typeof timeoutSeconds !== "number" ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > ports.config.maxWaitSeconds
      ) {
        throw new CommandExecutionError(
          `dispatch/wait refused: timeoutSeconds must be an integer between 1 and ${ports.config.maxWaitSeconds}`,
        );
      }
      return await ports.wait(
        { children, mode, timeoutSeconds },
        ports.abortSignal,
      );
    },
  };
}

function defineDispatchRead(
  ports: DispatchSessionPorts,
): CommandDefinition<DispatchReadResult> {
  return {
    id: "dispatch/read",
    title: "Read a child session's report",
    description:
      "Read a dispatched child session's turn report (capped at 16 KiB per " +
      "turn) and value-checked tool events inside a `<child-report>` envelope.",
    inputSchema: {
      type: "object",
      required: ["child"],
      properties: {
        child: {
          type: "string",
          pattern: DISPATCH_LABEL_SCHEMA_PATTERN,
          description: "Label of a child started by this coordinator.",
        },
        turns: {
          anyOf: [
            { type: "string", enum: ["last"] },
            {
              type: "integer",
              minimum: 1,
              maximum: MAX_DISPATCH_READ_TURNS,
            },
          ],
          description:
            'Turns to read: "last" (default) or an integer from 1 to 20.',
        },
        toolEvents: {
          type: "boolean",
          description:
            "Default true. Include bounded tool name, status, and summary per turn.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["emit.event"],
      defaultDecision: "allow",
      resources: ["dispatch:child"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    modelResult: (result) =>
      typeof result === "string"
        ? result
        : formatDispatchReadResult(result as DispatchReadResult),
    executor: async (call) => {
      const child = call.arguments["child"];
      if (typeof child !== "string" || !DISPATCH_LABEL_PATTERN.test(child)) {
        throw new CommandExecutionError(
          "dispatch/read refused: child must be a valid child label",
        );
      }
      const rawTurns = call.arguments["turns"] ?? "last";
      const turns: "last" | number = rawTurns === "last"
        ? "last"
        : typeof rawTurns === "number" &&
            Number.isInteger(rawTurns) &&
            rawTurns >= 1 &&
            rawTurns <= MAX_DISPATCH_READ_TURNS
        ? rawTurns
        : (() => {
          throw new CommandExecutionError(
            `dispatch/read refused: turns must be "last" or an integer from 1 to ${MAX_DISPATCH_READ_TURNS}`,
          );
        })();
      const toolEvents = call.arguments["toolEvents"] !== false;
      return await ports.read({ child, turns, toolEvents });
    },
  };
}

function defineDispatchSend(
  ports: DispatchSessionPorts,
): CommandDefinition<DispatchSendResult> {
  return {
    id: "dispatch/send",
    title: "Send a follow-up turn to a child session",
    description:
      "Send one follow-up message (at most 32 KiB UTF-8) to an `idle` child " +
      "session inside a `<coordinator-message>` envelope. Refused when the " +
      "child is `running` or `awaiting_approval`.",
    inputSchema: {
      type: "object",
      required: ["child", "message"],
      properties: {
        child: {
          type: "string",
          pattern: DISPATCH_LABEL_SCHEMA_PATTERN,
          description: "Label of an idle child started by this coordinator.",
        },
        message: {
          type: "string",
          description:
            "Follow-up instructions (at most 32 KiB UTF-8), delivered inside a coordinator-message envelope.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process", "write.filesystem", "emit.event"],
      defaultDecision: "ask",
      resources: ["dispatch:child"],
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    grantable: true,
    // A session grant covers one child label on this coordinator session; the
    // grant key and the approval prompt never carry message text. The precheck
    // reads the message only to enforce its type and size limit.
    grantArguments: ["child"],
    approvalArguments: (call) => ({
      child: call.arguments["child"],
    }),
    approvalTitle: (call) => {
      const child = typeof call.arguments["child"] === "string"
        ? call.arguments["child"]
        : "child";
      return `Send follow-up turn to child ${child}`;
    },
    precheck: async (call) => {
      if (ports.depth !== 0) {
        return "dispatch/send is unavailable in a child session";
      }
      const child = call.arguments["child"];
      const message = call.arguments["message"];
      if (typeof child !== "string" || !DISPATCH_LABEL_PATTERN.test(child)) {
        return "dispatch/send refused: child must be a valid child label";
      }
      if (typeof message !== "string") {
        return "dispatch/send refused: message must be a string";
      }
      if (exceedsUtf8Limit(message, MAX_DISPATCH_TASK_BYTES)) {
        return `dispatch/send refused: message exceeds the ${MAX_DISPATCH_TASK_BYTES}-byte (32 KiB) limit`;
      }
      const refusal = await ports.checkSend(child);
      return refusal === null ? null : `dispatch/send refused: ${refusal}`;
    },
    executor: async (call) => {
      if (ports.depth !== 0) {
        throw new CommandExecutionError(
          "dispatch/send is unavailable in a child session",
        );
      }
      const child = call.arguments["child"];
      const message = call.arguments["message"];
      if (typeof child !== "string" || !DISPATCH_LABEL_PATTERN.test(child)) {
        throw new CommandExecutionError(
          "dispatch/send refused: child must be a valid child label",
        );
      }
      if (typeof message !== "string") {
        throw new CommandExecutionError(
          "dispatch/send refused: message must be a string",
        );
      }
      if (exceedsUtf8Limit(message, MAX_DISPATCH_TASK_BYTES)) {
        throw new CommandExecutionError(
          `dispatch/send refused: message exceeds the ${MAX_DISPATCH_TASK_BYTES}-byte (32 KiB) limit`,
        );
      }
      return await ports.send({ child, message });
    },
  };
}

/**
 * Define the four bounded coordinator dispatch tools (`dispatch/start`,
 * `dispatch/wait`, `dispatch/read`, `dispatch/send`) for a depth-0 session.
 * Returns an empty list if `ports.depth !== 0`.
 */
export function defineDispatchTools(
  ports: DispatchSessionPorts,
): readonly CommandDefinition[] {
  if (ports.depth !== 0) return [];
  return [
    defineDispatchStart(ports),
    defineDispatchWait(ports),
    defineDispatchRead(ports),
    defineDispatchSend(ports),
  ];
}
