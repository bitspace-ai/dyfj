/**
 * Happy-path Dolt time-travel for events/query over UDS (integration).
 *
 * AS OF TIMESTAMP is commit time-travel, not a created_at filter. writeEvent
 * is a bare autocommit INSERT; that is a MySQL commit, not necessarily a Dolt
 * commit on the fixture sql-server. After the first batch this test
 * CALL DOLT_COMMITs if dolt_status is dirty so the row is in Dolt history
 * before the second batch is written. The captured asOf is UTC
 * second-precision (TIMESTAMP() compares in UTC) taken after a one-second
 * gap so it is strictly after the first commit and strictly before the
 * second.
 *
 * The aggregate integration fixture provides the isolated Dolt sql-server.
 */

import { afterAll, describe, expect, test } from "vitest";
import { serveWorkbenchUnix, type WorkbenchUnixServer } from "./uds-server";
import { connectUnixClient } from "./uds-client";
import { isValidAsOfTimestamp } from "./sessions";
import {
  doltExec,
  doltQuery,
  generateSpanId,
  generateTraceId,
  generateULID,
  writeEvent,
} from "./utils";

const HISTORICAL = "ASOF_HISTORICAL_batch";
const HEAD = "ASOF_HEAD_batch";

async function insertEvent(sessionId: string, content: string): Promise<void> {
  await writeEvent({
    event_id: generateULID(),
    session_id: sessionId,
    event_type: "session_start",
    trace_id: generateTraceId(),
    span_id: generateSpanId(),
    principal_id: "asof-uds-test",
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: "policy:loopback-local",
    content,
  });
}

/** Make the current working set a Dolt commit if autocommit did not. */
async function commitIfDirty(): Promise<void> {
  const status = await doltQuery("SELECT table_name FROM dolt_status");
  if (status.length === 0) return;
  await doltExec("CALL DOLT_COMMIT('-Am', 'asof test batch')");
}

async function doltUtcSeconds(): Promise<string> {
  const rows = await doltQuery(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS ts",
  );
  const ts = rows[0]?.ts ?? "";
  if (!isValidAsOfTimestamp(ts)) {
    throw new Error(`dolt UTC now() is not a valid asOf timestamp: ${ts}`);
  }
  return ts;
}

describe("events/query asOf (integration)", () => {
  const sessionId = generateULID();
  let server: WorkbenchUnixServer | undefined;
  let socketPath: string | undefined;

  afterAll(async () => {
    await server?.close();
    if (socketPath) {
      try {
        await Deno.remove(socketPath);
      } catch {
        // already gone
      }
    }
    await doltExec("DELETE FROM events WHERE session_id = ?", [sessionId]);
  });

  test(
    "asOf returns the historical set; omitting it returns head",
    async () => {
      await insertEvent(sessionId, HISTORICAL);
      await commitIfDirty();
      await doltQuery("SELECT SLEEP(1)");
      const asOf = await doltUtcSeconds();
      await doltQuery("SELECT SLEEP(1)");
      await insertEvent(sessionId, HEAD);
      await commitIfDirty();

      socketPath = `/tmp/dyfj-asof-${crypto.randomUUID()}.sock`;
      server = await serveWorkbenchUnix(socketPath, {});
      const client = await connectUnixClient(server.socketPath);
      try {
        const historical = await client.request("events/query", {
          sessionId,
          asOf,
        }) as { events: Array<{ content: string | null }> };
        const head = await client.request("events/query", {
          sessionId,
        }) as { events: Array<{ content: string | null }> };

        const historicalContent = historical.events.map((event) => event.content);
        const headContent = head.events.map((event) => event.content);
        expect(historicalContent).toEqual([HISTORICAL]);
        expect(headContent).toEqual([HISTORICAL, HEAD]);
      } finally {
        client.close();
      }
    },
    30_000,
  );
});
