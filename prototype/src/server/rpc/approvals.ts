// The `approvals` namespace: the operator's view of approvals that wait for
// them. `approvals/pending` lists the requests parked for one session, and
// `approvals/answer` answers one of them. These are operator RPC methods on
// the runtime socket, never agent tools. A client calls them after attaching
// to a session (`dyfj --session <id>`).
//
// The answer is the raw response a connected client would have sent to an
// `approval` request; the parked turn's approver parses it with the same
// fail-closed rules (`approval.ts`). An answer for an id that is not pending
// for that session is refused, and so is a second answer for one id.

import {
  asRecord,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import type { ParkedApprovals } from "../parked-approvals.ts";

export interface ApprovalsHandlerDeps {
  parked: Pick<ParkedApprovals, "pending" | "answer">;
}

const MAX_ID_LENGTH = 128;

function requiredId(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

export function buildApprovalsHandlers(
  deps: ApprovalsHandlerDeps,
): RpcHandlers {
  return {
    "approvals/pending": (params) => {
      const sessionId = requiredId(asRecord(params), "sessionId");
      return { approvals: deps.parked.pending(sessionId) };
    },
    "approvals/answer": (params) => {
      const record = asRecord(params);
      const sessionId = requiredId(record, "sessionId");
      const approvalId = requiredId(record, "approvalId");
      if (!("response" in record)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "response is required",
        );
      }
      if (!deps.parked.answer(sessionId, approvalId, record.response)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          `approval ${approvalId} is not pending for session ${sessionId}`,
        );
      }
      return { answered: true };
    },
  };
}
