// The `events` namespace: a session's event log, optionally as of a point in
// time. The session id, `asOf` and `limit` are validated before any read.

import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import { isValidAsOfTimestamp } from "../../store/mod.ts";
import {
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./params.ts";

export interface SessionEventsRequest {
  sessionId: string;
  eventId?: string;
  asOf?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export type FetchSessionEvents = (
  input: SessionEventsRequest,
) => Promise<WorkbenchSessionEvent[]>;

export interface EventsHandlerDeps {
  fetchSessionEvents: FetchSessionEvents;
}

export function buildEventsHandlers(deps: EventsHandlerDeps): RpcHandlers {
  return {
    "events/query": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const asOf = sanitizeRpcString(record.asOf, "asOf", { maxLen: 64 });
      if (asOf !== undefined && !isValidAsOfTimestamp(asOf)) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query asOf must be a valid timestamp",
        );
      }
      if (
        record.limit !== undefined &&
        (typeof record.limit !== "number" ||
          !Number.isInteger(record.limit) ||
          record.limit <= 0 ||
          record.limit > 1000)
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "events/query limit must be a positive integer between 1 and 1000",
        );
      }
      const limit = typeof record.limit === "number" && record.limit > 0
        ? record.limit
        : 500;
      const fetched = await deps.fetchSessionEvents({
        sessionId,
        asOf: typeof asOf === "string" ? asOf : undefined,
        limit,
      });
      return {
        events: Array.isArray(fetched) ? fetched.slice(0, limit) : [],
      };
    },
  };
}
