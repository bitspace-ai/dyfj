/**
 * Call-shape policy: the verdict (`allow`, `ask`, `deny`) for one command call,
 * from the command's declared permission envelope and the operator posture.
 * Model-supplied arguments are validated here but never read as justification
 * (README Section 1, "Permissions reason about call shape").
 */

import type { PermissionLevel } from "../config/mod.ts";
import type {
  CommandCall,
  CommandDefinition,
  CommandEffect,
  CommandPolicyResult,
} from "./definition.ts";
import {
  formatInvalidArgumentsReason,
  validateCommandArguments,
} from "./validate.ts";

// Exec-class effects spawn external processes. Operator auto-approval NEVER
// covers them: command execution always requires an explicit per-call approval,
// regardless of the filesystem/cost/network envelope (the no-exec invariant).
// Metadata alone must not be trusted to gate exec — this effect check is the gate.
const EXEC_EFFECTS: ReadonlySet<CommandEffect> = new Set([
  "run.checks",
  "run.process",
]);

/**
 * Policy context for the operator permission profile. Defaults are safe: an
 * absent context behaves as `strict` on a non-loopback turn, so nothing
 * auto-approves unless deliberately enabled.
 */
export interface CommandPolicyContext {
  /** Operator posture from config: "strict" (per-call approval) | "operator". */
  permissionLevel?: PermissionLevel;
  /** Whether this turn is on the canonical loopback transport. */
  loopback?: boolean;
}

export function evaluateCommandPolicy(
  command: CommandDefinition,
  call: CommandCall,
  context: CommandPolicyContext = {},
): CommandPolicyResult {
  const validationError = validateCommandArguments(
    command.inputSchema,
    call.arguments,
  );
  if (validationError) {
    return {
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      reason: formatInvalidArgumentsReason(
        command.id,
        command.inputSchema,
        call.arguments,
        validationError,
      ),
    };
  }

  if (
    command.permission.network === "configured-external" &&
    command.permission.defaultDecision === "allow" &&
    command.permission.effects.includes("read.external") &&
    !command.permission.effects.includes("write.external") &&
    command.permission.filesystem === "none" &&
    command.permission.cost === "none"
  ) {
    return {
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-external-read",
    };
  }

  if (
    command.permission.network === "recall" &&
    command.permission.defaultDecision === "allow" &&
    command.permission.filesystem === "none" &&
    command.permission.cost === "none"
  ) {
    // Read-only recall to an operator-configured, fixed external memory endpoint.
    // The model chooses the query, never the destination, and the tool is
    // registered only for loopback/operator turns with the endpoint configured —
    // so this egress is auto-allowed without a per-call prompt, with its own
    // audit basis distinct from arbitrary external network.
    return {
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-recall",
    };
  }

  if (
    command.permission.defaultDecision === "allow" &&
    (command.permission.filesystem === "none" ||
      command.permission.filesystem === "read") &&
    command.permission.cost === "none" &&
    command.permission.network !== "external" &&
    command.permission.network !== "recall"
  ) {
    // Read-only local access (memory reads, workspace file reads) needs no
    // approval. Write filesystem, paid cost, and external network still fall
    // through to "ask"/"deny" until the Slice B safety model gates them.
    return {
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
    };
  }

  if (command.permission.defaultDecision === "deny") {
    return {
      decision: "deny",
      authzBasis: "policy:deny:default",
      reason: "command default decision is deny",
    };
  }

  // Operator permission profile (config permissionLevel="operator", on a
  // loopback/operator turn): a CONTAINED mutating tool — local, free,
  // workspace-write, NON-exec — is auto-approved without a per-call prompt, with
  // its own audit basis. Command-execution, paid, or networked tools are
  // deliberately NOT covered and still fall through to "ask" even under the
  // operator profile. The no-exec invariant (`!executesProcesses`) is the
  // explicit gate: a tool carrying a run.* effect can never auto-approve here,
  // even if its filesystem/cost/network envelope would otherwise match — so bash
  // always asks regardless of how its metadata is tagged.
  if (
    context.permissionLevel === "operator" &&
    context.loopback === true &&
    command.permission.defaultDecision === "allow" &&
    command.permission.filesystem === "write" &&
    command.permission.cost === "none" &&
    (command.permission.network === "none" ||
      command.permission.network === undefined) &&
    !command.permission.effects.some((effect) => EXEC_EFFECTS.has(effect))
  ) {
    return {
      decision: "allow",
      authzBasis: "policy:allow:operator-profile",
    };
  }

  return {
    decision: "ask",
    authzBasis: "policy:ask:default",
    reason: "command requires operator approval",
  };
}
