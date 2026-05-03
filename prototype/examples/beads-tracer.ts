/**
 * DYFJ Workbench — Beads tracer-bullet
 *
 * Demonstrates the parallel-spawn-and-gate coordination pattern using Beads as
 * the substrate. An orchestrator agent opens a parent epic, spawns N child
 * tasks (each representing work to be done in parallel by a worker), gates on
 * their completion, surfaces aggregated results, and cleans up.
 *
 * This is one of the foundational coordination patterns for any multi-agent
 * system: a primary actor needs to dispatch independent subtasks, hold its own
 * attention while they execute, and recombine the results in a controllable
 * order. Beads provides the substrate primitives (epic + child tasks + status
 * transitions + queryable history) that make the pattern tractable without
 * authoring custom transport, queue, or audit infrastructure.
 *
 * What this demonstrates:
 *   1. Orchestrator creates an epic representing the session
 *   2. Orchestrator spawns 3 child tasks attached to the epic via --parent
 *      (Beads produces hierarchical IDs automatically: parent.1, .2, .3)
 *   3. Stubbed worker tasks run in parallel; each closes its bead with a note
 *      when done (simulating real work returning a result)
 *   4. Orchestrator polls bd to detect completion and surfaces results in
 *      causal/spawn order
 *   5. Epic is closed once all children are done
 *   6. Cleanup deletes the demo beads (this is a tracer, not state to keep)
 *
 * What this does NOT do (out of scope for tracer-bullet):
 *   - Real model calls (worker tasks are stubbed with sleep + canned result)
 *   - Cross-rig federation (single local beads instance)
 *   - Policy enforcement (no routing decisions made)
 *
 * Run with:
 *   BEADS_DIR=/path/to/.beads bun run examples/beads-tracer.ts
 *
 * (BEADS_DIR points at an existing Beads workspace. The tracer creates and
 * deletes demo beads in that workspace; no other state is touched.)
 *
 * Honest integration cost notes:
 *   - bd CLI shell-out via Bun.$ is the production-realistic shape
 *   - JSON output mode (`bd show --json`) returns an ARRAY (single-id queries
 *     return a 1-element array); parse accordingly
 *   - Per-operation bd overhead is ~500-800ms (Dolt write + git semantics);
 *     fine for low-frequency coordination patterns, would matter for
 *     high-frequency intra-loop coordination
 */

import { $ } from "bun";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BdIssue {
  id: string;
  title: string;
  status: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

interface WorkerTask {
  query: string;
  simulatedDelayMs: number;
  cannedResult: string;
}

// ── bd CLI shell-out helpers ──────────────────────────────────────────────────

async function bdCreate(args: {
  title: string;
  description: string;
  type: "epic" | "task";
  labels?: string[];
  parent?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const labelArg = args.labels ? ["--labels", args.labels.join(",")] : [];
  const parentArg = args.parent ? ["--parent", args.parent] : [];
  const metadataArg = args.metadata ? ["--metadata", JSON.stringify(args.metadata)] : [];

  const proc = await $`bd create --title=${args.title} --description=${args.description} --type=${args.type} ${labelArg} ${parentArg} ${metadataArg}`.quiet();
  const output = proc.stdout.toString();
  const match = output.match(/Created issue:\s+(\S+)/);
  if (!match) throw new Error(`bd create failed to return ID: ${output}`);
  return match[1];
}

async function bdShow(id: string): Promise<BdIssue> {
  const proc = await $`bd show ${id} --json`.quiet().nothrow();
  if (proc.exitCode !== 0) {
    throw new Error(`bd show ${id} failed: ${proc.stderr.toString()}`);
  }
  // bd show --json returns an array (for multi-id queries); single-id returns 1 element
  const parsed = JSON.parse(proc.stdout.toString());
  const issue = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!issue) throw new Error(`bd show ${id} returned no issue`);
  return issue as BdIssue;
}

async function bdNote(id: string, note: string): Promise<void> {
  await $`bd note ${id} ${note}`.quiet();
}

async function bdClose(id: string, reason: string): Promise<void> {
  await $`bd close ${id} --reason=${reason}`.quiet();
}

async function bdDelete(id: string): Promise<void> {
  await $`bd delete ${id} --force`.quiet().nothrow();
}

// ── Stubbed worker task ───────────────────────────────────────────────────────

async function runStubbedWorker(
  taskId: string,
  task: WorkerTask,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, task.simulatedDelayMs));
  await bdNote(taskId, `Result: ${task.cannedResult}`);
  await bdClose(taskId, "worker complete (stubbed)");
}

// ── Orchestrator gate-poll ────────────────────────────────────────────────────

async function awaitTaskCompletion(
  taskIds: string[],
  pollIntervalMs = 200,
  timeoutMs = 10_000,
): Promise<Map<string, BdIssue>> {
  const start = Date.now();
  const results = new Map<string, BdIssue>();

  while (results.size < taskIds.length) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for tasks; got ${results.size}/${taskIds.length}`,
      );
    }
    for (const id of taskIds) {
      if (results.has(id)) continue;
      const issue = await bdShow(id);
      if (issue.status === "closed") results.set(id, issue);
    }
    if (results.size < taskIds.length) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return results;
}

// ── Demo: parallel-spawn-and-gate pattern ─────────────────────────────────────

async function demo(): Promise<void> {
  console.log("=".repeat(60));
  console.log("DYFJ Beads Tracer — parallel-spawn-and-gate pattern");
  console.log("=".repeat(60));

  const sessionId = `demo-${Date.now()}`;

  // ── Phase 1: Orchestrator opens the parent epic ──────────────────────────
  console.log("\n[Phase 1] Orchestrator opens the parent epic");
  const epicId = await bdCreate({
    title: `Tracer session ${sessionId}`,
    description: "Demo epic for the parallel-spawn-and-gate pattern. Spawns 3 worker tasks; orchestrator gates on completion; results surfaced in causal order.",
    type: "epic",
    labels: ["tracer", "demo", `session-${sessionId}`],
    metadata: {
      session_id: sessionId,
      service_name: "dyfj.beads-tracer",
    },
  });
  console.log(`  → Epic created: ${epicId}`);

  // ── Phase 2: Orchestrator spawns parallel child tasks ────────────────────
  console.log("\n[Phase 2] Orchestrator spawns 3 parallel child tasks");
  const workerTasks: WorkerTask[] = [
    {
      query: "task-a",
      simulatedDelayMs: 600,
      cannedResult: "result from task-a (stubbed payload)",
    },
    {
      query: "task-b",
      simulatedDelayMs: 1200,
      cannedResult: "result from task-b (stubbed payload, longer execution)",
    },
    {
      query: "task-c",
      simulatedDelayMs: 400,
      cannedResult: "result from task-c (stubbed payload, fastest)",
    },
  ];

  const childIds: string[] = [];
  for (const task of workerTasks) {
    const childId = await bdCreate({
      title: `Worker: ${task.query}`,
      description: `Spawned by orchestrator during ${sessionId}. Query: ${task.query}`,
      type: "task",
      labels: ["tracer", "worker", `session-${sessionId}`],
      parent: epicId,
      metadata: {
        session_id: sessionId,
        query: task.query,
        spawned_at: new Date().toISOString(),
      },
    });
    childIds.push(childId);
    console.log(`  → Spawned: ${childId} (${task.query})`);
  }

  // ── Phase 3: Run stubbed workers in parallel ─────────────────────────────
  console.log("\n[Phase 3] Stubbed workers running in parallel");
  const startT = Date.now();
  Promise.all(
    workerTasks.map((task, i) => runStubbedWorker(childIds[i], task)),
  ).catch((err) => console.error("Stubbed worker error:", err));

  // ── Phase 4: Orchestrator gates on completion ────────────────────────────
  console.log("\n[Phase 4] Orchestrator polling bd for completion (the gate)");
  const results = await awaitTaskCompletion(childIds);
  const elapsedMs = Date.now() - startT;
  console.log(`  → All ${results.size} tasks complete in ${elapsedMs}ms`);

  // ── Phase 5: Surface results in causal/spawn order ───────────────────────
  console.log("\n[Phase 5] Orchestrator surfaces results in causal/spawn order");
  for (const id of childIds) {
    const issue = results.get(id);
    if (!issue) continue;
    console.log(`  • ${issue.title}`);
    const noteText = issue.notes ?? "(no note returned)";
    console.log(`    ${noteText}`);
  }

  // ── Phase 6: Close the epic ──────────────────────────────────────────────
  console.log("\n[Phase 6] Orchestrator closes the epic");
  await bdClose(epicId, "tracer session complete");
  console.log(`  → Epic ${epicId} closed`);

  // ── Phase 7: Cleanup ─────────────────────────────────────────────────────
  console.log("\n[Phase 7] Cleanup (this is a tracer, not state to keep)");
  for (const id of childIds) {
    await bdDelete(id);
  }
  await bdDelete(epicId);
  console.log(`  → Deleted ${childIds.length + 1} demo beads`);

  console.log("\n" + "=".repeat(60));
  console.log("Tracer-bullet complete. Pattern proven end-to-end:");
  console.log("  spawn → parallel execute → gate → surface → close → cleanup");
  console.log("=".repeat(60));
}

// ── Entry ─────────────────────────────────────────────────────────────────────

demo().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
