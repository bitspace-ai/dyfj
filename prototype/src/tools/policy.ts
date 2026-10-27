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
  ContainmentVerdict,
  SessionGrants,
} from "./definition.ts";
import {
  formatInvalidArgumentsReason,
  validateCommandArguments,
} from "./validate.ts";

// The effects a contained command may have for the attested envelope to
// cover it: a process, the filesystem it can reach, and its own events. A
// command with any other effect (external writes, paid calls) keeps its own
// verdict, whatever its containment.
const ENVELOPE_EFFECTS: ReadonlySet<CommandEffect> = new Set([
  "run.process",
  "read.filesystem",
  "write.filesystem",
  "emit.event",
]);

// Exec-class effects spawn external processes. Operator auto-approval does not
// cover them: on its own, the operator posture never skips the prompt for
// command execution, whatever the filesystem/cost/network envelope (the no-exec
// invariant). Metadata alone must not be trusted to gate exec — this effect
// check is the gate. The two declared exceptions are below: the attested
// envelope, which rests on an attested OS boundary and an operator grant, not
// on the posture; and the BIT-707 read-only classifier, on the native route.
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
  /**
   * The session's "allow for the rest of the session" grants, on a loopback
   * turn. Absent, nothing is offered or granted. `invokeCommand` consults it
   * after an `ask` verdict.
   */
  sessionGrants?: SessionGrants;
  /**
   * The attestation of the command's containment for this call, when the
   * command declares one (`invokeCommand` sets it). Absent, a contained
   * command is treated as unattested.
   */
  containment?: ContainmentVerdict;
}

/** The basis of an unsandboxed call's prompt; such a call is never granted for the session. */
export const UNSANDBOXED_ASK_BASIS = "policy:ask:unsandboxed";

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

  if (command.permission.defaultDecision === "deny") {
    return {
      decision: "deny",
      authzBasis: "policy:deny:default",
      reason: "command default decision is deny",
    };
  }

  // The attested envelope (BIT-736), evaluated before every generic
  // auto-allow path below, so a contained command never reaches one of them.
  // A command that runs in the isolated executor may run without a prompt
  // when its containment is attested for
  // this call, the operator's grant names the envelope's policy digest, and
  // the turn is on loopback. Neither the posture nor the call's arguments
  // decide it; only a deadline longer than the envelope's is read. One the
  // model chose is refused as an argument it can correct, not asked for
  // (BIT-796); a fixed one asks. Without all three, a contained command asks (one whose default
  // decision is deny was already denied above): the read-only
  // classifier below never runs for it.
  // The srt sandbox (BIT-662), evaluated here for the same reason: a
  // sandboxed command never reaches a generic auto-allow path.
  if (command.containment?.route === "srt") {
    return evaluateSandboxedPolicy(command, call, context);
  }

  if (command.containment !== undefined) {
    const verdict = context.containment;
    if (
      verdict?.status === "attested" && verdict.granted &&
      context.loopback === true &&
      command.permission.cost === "none" &&
      command.permission.effects.every((effect) => ENVELOPE_EFFECTS.has(effect))
    ) {
      const asked = command.containment.callTimeoutMs?.(call);
      if (asked !== undefined && asked > verdict.envelope.commandTimeoutMs) {
        const limit = verdict.envelope.commandTimeoutMs / 1_000;
        const argument = command.containment.deadlineArgument;
        return argument !== undefined && call.arguments[argument] !== undefined
          ? {
            decision: "deny",
            authzBasis: "policy:deny:envelope-limit",
            reason: `${argument} ${asked / 1_000} s is above the executor's ` +
              `limit of ${limit} s; call again with ${argument} of at most ${limit}`,
          }
          : {
            decision: "ask",
            authzBasis: "policy:ask:envelope-limit",
            reason: `the call's deadline (${asked / 1_000} s) is above the ` +
              `envelope's ${limit} s`,
          };
      }
      return { decision: "allow", authzBasis: "policy:allow:attested-envelope" };
    }
    return {
      decision: "ask",
      authzBasis: "policy:ask:default",
      reason: verdict?.status === "unattested"
        ? `command requires operator approval (containment unattested: ${verdict.reason})`
        : verdict?.status === "attested" && !verdict.granted
        ? `command requires operator approval (${
          verdict.grantRefusal === undefined
            ? "no envelope grant for this executor policy"
            : `envelope grant refused: ${verdict.grantRefusal}`
        })`
        : "command requires operator approval",
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


  // Operator permission profile (config permissionLevel="operator", on a
  // loopback/operator turn): a CONTAINED mutating tool — local, free,
  // workspace-write, NON-exec — is auto-approved without a per-call prompt, with
  // its own audit basis. Command-execution, paid, or networked tools are
  // deliberately NOT covered and still fall through to "ask" even under the
  // operator profile. The no-exec invariant (`!executesProcesses`) is the
  // explicit gate: a tool carrying a run.* effect can never auto-approve here,
  // even if its filesystem/cost/network envelope would otherwise match — so bash
  // asks regardless of how its metadata is tagged, save for the read-only
  // allowlist below.
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

  // The read-only allowlist (BIT-707): the one declared exception to the
  // no-exec invariant, and to "permission checks ignore model-supplied
  // arguments" (README Section 1). A command that declares `readOnlyCall`
  // (bash) may skip the prompt for a call it judges read-only, under the
  // operator posture on loopback only. The check fails closed, so a mistake
  // costs a prompt rather than skipping one.
  if (
    context.permissionLevel === "operator" &&
    context.loopback === true &&
    command.readOnlyCall?.(call) === true
  ) {
    return {
      decision: "allow",
      authzBasis: "policy:allow:bash-allowlist",
    };
  }

  return {
    decision: "ask",
    authzBasis: "policy:ask:default",
    reason: "command requires operator approval",
  };
}

/**
 * The verdict for a command on the srt route (BIT-662). It runs without a
 * prompt when its sandbox is on (the boot probe passed), the turn is on
 * loopback and the operator posture is set; under `strict` it asks (a
 * session grant the operator gave still applies). As for the attested envelope, only process and filesystem effects
 * at no cost are covered. Otherwise it asks; the read-only classifier never
 * runs for it. A call that escapes the sandbox (bash's `unsandboxed`) runs on
 * the native route, so it always asks, whatever the posture, and is refused
 * where no operator can be asked or no reason was given.
 */
function evaluateSandboxedPolicy(
  command: CommandDefinition,
  call: CommandCall,
  context: CommandPolicyContext,
): CommandPolicyResult {
  const verdict = context.containment;
  if (command.containment?.escapesSandbox?.(call) === true) {
    const reason = call.arguments.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      return {
        decision: "deny",
        authzBasis: "policy:deny:unsandboxed-without-reason",
        reason: "unsandboxed: true requires a reason: say why the command " +
          "cannot run in the sandbox",
      };
    }
    if (context.loopback !== true) {
      return {
        decision: "deny",
        authzBasis: "policy:deny:unsandboxed-headless",
        reason: "unsandboxed commands run only with an operator present to " +
          "approve them",
      };
    }
    return {
      decision: "ask",
      authzBasis: UNSANDBOXED_ASK_BASIS,
      reason: "command asks to run outside the sandbox",
    };
  }
  if (
    verdict?.status === "sandboxed" &&
    context.loopback === true &&
    context.permissionLevel === "operator" &&
    command.permission.cost === "none" &&
    command.permission.effects.every((effect) => ENVELOPE_EFFECTS.has(effect))
  ) {
    return { decision: "allow", authzBasis: "policy:allow:sandboxed" };
  }
  return {
    decision: "ask",
    authzBasis: "policy:ask:default",
    reason: verdict?.status === "sandboxed"
      ? "command requires operator approval (sandboxed calls run without " +
        "a prompt only under the operator posture)"
      : "command requires operator approval (the sandbox is not attested " +
        "for this call)",
  };
}
