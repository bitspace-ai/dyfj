import { doltQuery, closeDoltPool } from "../src/utils";
import { runWorkbench } from "../src/workbench";
import {
  verifyWorkbenchEventSequence,
  type WorkbenchEventRow,
} from "../src/workbench-events";

const prompt = "Say ok.";
const captured: string[] = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  captured.push(line);
  originalLog(...args);
};

console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  captured.push(line);
  originalError(...args);
};

try {
  await runWorkbench(["--prompt", prompt]);

  const output = captured.join("\n");
  const sessionId = matchRequired(output, /^Session:\s+([0-9A-Z]{26})$/m, "session id");
  const traceId = matchRequired(output, /^Trace:\s+([0-9a-f]{32})$/m, "trace id");

  const rows = (await doltQuery(
    "SELECT event_type, session_id, trace_id " +
      "FROM events " +
      `WHERE session_id = '${sessionId}' ` +
      "ORDER BY created_at, event_id;",
  )).map((row): WorkbenchEventRow => ({
    event_type: row.event_type,
    session_id: row.session_id,
    trace_id: row.trace_id,
  }));

  const result = verifyWorkbenchEventSequence(rows);
  if (!result.ok) {
    console.error("Workbench event sequence verification failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    console.error(`Observed events: ${result.eventTypes.join(" -> ")}`);
    Deno.exit(1);
  }

  if (result.traceId !== traceId) {
    console.error(`Workbench trace mismatch: receipt=${traceId} events=${result.traceId}`);
    Deno.exit(1);
  }

  console.log("");
  console.log("Workbench event sequence verified");
  console.log(`Session: ${sessionId}`);
  console.log(`Trace:   ${traceId}`);
  console.log(`Events:  ${result.eventTypes.join(" -> ")}`);
  if (!result.eventTypes.includes("tool_call")) {
    console.log("Tools:   no tool_call expected in the current no-tool Workbench turn");
  }
} finally {
  console.log = originalLog;
  console.error = originalError;
  await closeDoltPool();
}

function matchRequired(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not parse ${label} from Workbench output`);
  return match[1];
}
