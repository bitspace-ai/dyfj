import { doltExec, type SqlParam } from "./utils";

export type SessionExec = (sql: string, params: SqlParam[]) => Promise<void>;

export interface WorkbenchSessionContentInput {
  mode: string;
  prompt: string;
  traceId: string;
  contextSources: string[];
  receipt?: string;
}

export interface CreateWorkbenchSessionInput {
  sessionId: string;
  slug: string;
  taskDescription: string;
  content: string;
  exec?: SessionExec;
}

export interface UpdateWorkbenchSessionInput {
  sessionId: string;
  content: string;
  exec?: SessionExec;
}

export function buildWorkbenchSessionSlug(sessionId: string): string {
  return `workbench-${sessionId.toLowerCase()}`;
}

export function buildWorkbenchSessionContent(
  input: WorkbenchSessionContentInput,
): string {
  const lines = [
    "# Workbench Session",
    "",
    `**Mode:** ${input.mode}`,
    `**Trace:** ${input.traceId}`,
    "",
    "## Prompt",
    "",
    input.prompt,
    "",
    "## Context Sources",
    "",
  ];
  if (input.contextSources.length === 0) {
    lines.push("- none");
  } else {
    for (const source of input.contextSources) {
      lines.push(`- ${source}`);
    }
  }
  if (input.receipt) {
    lines.push("", "## Receipt", "", input.receipt);
  }
  return lines.join("\n");
}

export async function createWorkbenchSession(
  input: CreateWorkbenchSessionInput,
): Promise<void> {
  const exec = input.exec ?? doltExec;
  await exec(
    "INSERT INTO sessions " +
      "(session_id, slug, session_name, task_description, phase, mode, content) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?);",
    [
      input.sessionId,
      input.slug,
      "Workbench Harness Shell",
      truncateTaskDescription(input.taskDescription),
      "execute",
      "interactive",
      input.content,
    ],
  );
}

export async function updateWorkbenchSession(
  input: UpdateWorkbenchSessionInput,
): Promise<void> {
  const exec = input.exec ?? doltExec;
  await exec(
    "UPDATE sessions SET phase = ?, progress_done = ?, progress_total = ?, " +
      "content = ? WHERE session_id = ?;",
    [
      "complete",
      1,
      1,
      input.content,
      input.sessionId,
    ],
  );
}

function truncateTaskDescription(value: string): string {
  return value.slice(0, 256);
}
