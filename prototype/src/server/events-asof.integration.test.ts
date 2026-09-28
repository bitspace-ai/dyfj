/**
 * Happy-path Dolt time-travel for events/query over UDS (integration).
 *
 * AS OF TIMESTAMP is commit time-travel, not a created_at filter. A
 * single-event journal commit is a bare autocommit INSERT; that is a MySQL commit, not necessarily a Dolt
 * commit on the fixture sql-server. After the first batch this test
 * CALL DOLT_COMMITs if dolt_status is dirty so the row is in Dolt history
 * before the second batch is written. The captured asOf is UTC
 * second-precision (TIMESTAMP() compares in UTC) taken after a one-second
 * gap so it is strictly after the first commit and strictly before the
 * second.
 *
 * The aggregate integration fixture provides the isolated Dolt sql-server.
 */

import { assertEquals } from "@std/assert";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import {
  generateSpanId,
  generateTraceId,
  generateULID,
} from "../kernel/mod.ts";
import { serveWorkbenchUnix } from "./main.ts";
import { connectUnixClient } from "../transport/mod.ts";
import { isValidAsOfTimestamp } from "../store/mod.ts";
import {
  openFixtureSql,
  openFixtureStore,
} from "../../testing/dolt/fixture-sql.ts";

const sql = openFixtureSql();
const store = openFixtureStore();

const HISTORICAL = "ASOF_HISTORICAL_batch";
const HEAD = "ASOF_HEAD_batch";

async function insertEvent(sessionId: string, content: string): Promise<void> {
  await store.journal.commit({
    events: [{
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
    }],
  });
}

/** Make the current working set a Dolt commit if autocommit did not. */
async function commitIfDirty(): Promise<void> {
  const status = await sql.query("SELECT table_name FROM dolt_status");
  if (status.length === 0) return;
  await sql.query("CALL DOLT_COMMIT('-Am', 'asof test batch')");
}

async function doltUtcSeconds(): Promise<string> {
  const rows = await sql.query(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS ts",
  );
  const ts = rows[0]?.ts ?? "";
  if (!isValidAsOfTimestamp(ts)) {
    throw new Error(`dolt UTC now() is not a valid asOf timestamp: ${ts}`);
  }
  return ts;
}

Deno.test("events/query asOf returns the historical set; omitting it returns head", async () => {
  const sessionId = generateULID();
  const socketPath = udsTestSocket("server-events-asof");
  try {
    await insertEvent(sessionId, HISTORICAL);
    await commitIfDirty();
    await sql.query("SELECT SLEEP(1)");
    const asOf = await doltUtcSeconds();
    await sql.query("SELECT SLEEP(1)");
    await insertEvent(sessionId, HEAD);
    await commitIfDirty();

    const server = await serveWorkbenchUnix(socketPath, { store });
    try {
      const client = await connectUnixClient(server.socketPath);
      try {
        const historical = await client.request("events/query", {
          sessionId,
          asOf,
        }) as { events: Array<{ content: string | null }> };
        const head = await client.request("events/query", {
          sessionId,
        }) as { events: Array<{ content: string | null }> };

        assertEquals(historical.events.map((event) => event.content), [
          HISTORICAL,
        ]);
        assertEquals(head.events.map((event) => event.content), [
          HISTORICAL,
          HEAD,
        ]);
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    try {
      await Deno.remove(socketPath);
    } catch {
      // already gone
    }
    await sql.query("DELETE FROM events WHERE session_id = ?", [sessionId]);
    await sql.close();
    await store.close();
  }
});
