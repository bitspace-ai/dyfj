/**
 * Containment attestation for the isolated machine's executor (BIT-736).
 * Before each call of a contained tool, the runtime asks the supervisor to
 * attest, checks the answer, and derives the approval envelope from the
 * executor's effective policy. The policy decision (`tools/policy.ts`) allows
 * a call without a prompt only when the result is `attested`, the operator's
 * grant names the envelope's policy digest, and the turn is on loopback.
 *
 * Every check fails closed. An unattested result changes only approval: the
 * tool still runs its commands in the executor or not at all, never here.
 *
 * The checks:
 * - the socket's directory is not writable by the runtime, so no process
 *   under the runtime's uid can have bound the socket. Node exposes no peer
 *   credential, so this ownership check stands in for one; on the machine
 *   the directory is root's and bound read-only;
 * - the reply echoes a fresh nonce, the lease is live, and the plan and
 *   policy files still hash as they did when the supervisor started;
 * - the supervisor's enforcement probe passed: a connect and a write outside
 *   the workspace were both refused by the kernel in a fresh executor;
 * - the executor policy parses, its digest verifies, it has not expired, and
 *   it has the envelope's required shape (`config/approval-envelope.ts`).
 *
 * The grant is read by the supervisor, not here. It is a root-owned file
 * beside the plans that the runtime's uid cannot write
 * (`scripts/sandbox-install.ts grant`), so the runtime cannot grant itself
 * the envelope.
 */

import { randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { deriveApprovalEnvelope } from "../../config/approval-envelope.ts";
import { parseEffectivePolicy } from "../../config/effective-policy.ts";
import type {
  CommandCall,
  Containment,
  ContainmentVerdict,
} from "../definition.ts";

export type { Containment, ContainmentVerdict };
import {
  type ExecutorDialer,
  requestAttestation,
} from "./executor-transport.ts";

export interface ContainmentOptions {
  /** The tool's default command deadline, in ms. */
  defaultCommandTimeoutMs: number;
  callTimeoutMs?: (call: CommandCall) => number | undefined;
  /** Throws unless the socket is one the runtime cannot have bound. */
  checkSocket?: (socket: string) => void;
  now?: () => Date;
}

/** The socket exists, is not the runtime's, and its directory is not writable to it. */
export function checkSocketOwnership(socket: string): void {
  const stat = lstatSync(socket);
  if (!stat.isSocket()) throw new Error("the executor socket is not a socket");
  if (stat.uid === process.getuid?.()) {
    throw new Error("the executor socket is owned by the runtime");
  }
  let writable = true;
  try {
    accessSync(dirname(socket), constants.W_OK);
  } catch {
    writable = false;
  }
  if (writable) {
    throw new Error("the executor socket's directory is writable by the runtime");
  }
}

function unattested(reason: string): ContainmentVerdict {
  return { status: "unattested", reason };
}

/** Checks one attestation reply against `nonce`, at `now`. */
export function checkAttestation(
  reply: Record<string, unknown>,
  nonce: string,
  now: Date,
  defaultCommandTimeoutMs: number,
): ContainmentVerdict {
  if (reply.nonce !== nonce) return unattested("the reply's nonce is not ours");
  if (typeof reply.instance !== "string" || !/^[0-9a-f]{32}$/.test(reply.instance)) {
    return unattested("the reply names no supervisor instance");
  }
  if (reply.lease !== "live") return unattested("the executor lease has expired");
  if (reply.filesUnchanged !== true) {
    return unattested("the executor plan or policy changed after the supervisor started");
  }
  const probe = reply.probe as Record<string, unknown> | null | undefined;
  if (probe === null || typeof probe !== "object" || probe.passed !== true) {
    return unattested("the supervisor's enforcement probe did not pass");
  }
  if (reply.executorPolicy === null || reply.executorPolicy === undefined) {
    return unattested("the supervisor has no executor policy");
  }
  let derived;
  try {
    derived = deriveApprovalEnvelope(
      parseEffectivePolicy(reply.executorPolicy),
      reply.instance,
      now,
      defaultCommandTimeoutMs,
    );
  } catch (error) {
    return unattested(`the executor policy is malformed: ${(error as Error).message}`);
  }
  if ("refusal" in derived) return unattested(derived.refusal);
  return {
    status: "attested",
    envelope: derived.envelope,
    granted: reply.grant === derived.envelope.policyDigest,
    ...(typeof reply.grantRefusal === "string"
      ? { grantRefusal: reply.grantRefusal }
      : {}),
  };
}

/** The containment of a tool whose commands run through the supervisor at `socket`. */
export function createContainment(
  socket: string,
  dial: ExecutorDialer | undefined,
  options: ContainmentOptions,
): Containment {
  const checkSocket = options.checkSocket ?? checkSocketOwnership;
  const now = options.now ?? (() => new Date());
  return {
    route: "linux-isolated",
    ...(options.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.callTimeoutMs }),
    async attest() {
      if (dial === undefined) {
        return unattested("no executor connection is configured");
      }
      try {
        checkSocket(socket);
      } catch (error) {
        return unattested((error as Error).message);
      }
      const nonce = randomBytes(16).toString("hex");
      let reply;
      try {
        reply = await requestAttestation(socket, dial, nonce);
      } catch (error) {
        return unattested((error as Error).message);
      }
      return checkAttestation(reply, nonce, now(), options.defaultCommandTimeoutMs);
    },
  };
}
