import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL_SUBJECT_MAX_BYTES,
  toolCallSubject,
  toolResultStatus,
} from "./call-subject.ts";
import type { CommandDefinition } from "./definition.ts";

/** A definition with only what these rules read. */
function command(
  properties: Record<string, { type: string; redact?: boolean }>,
  flags: { redactArguments?: boolean; redactResult?: boolean } = {},
): CommandDefinition {
  return {
    id: "t",
    title: "T",
    inputSchema: { type: "object", properties },
    ...flags,
  } as unknown as CommandDefinition;
}

const writeFile = command({
  path: { type: "string" },
  content: { type: "string", redact: true },
});
const bash = command({ command: { type: "string" }, cwd: { type: "string" } }, {
  redactResult: true,
});

test("the subject is the first logged string argument in schema order", () => {
  assert.equal(
    toolCallSubject(writeFile, { content: "body", path: "notes.md" }),
    "notes.md",
  );
  assert.equal(toolCallSubject(bash, { cwd: "src", command: "npm test" }), "npm test");
});

test("a redacted argument is never the subject", () => {
  const editFile = command({
    content: { type: "string", redact: true },
    path: { type: "string" },
  });
  assert.equal(toolCallSubject(editFile, { content: "secret", path: "a.ts" }), "a.ts");
  assert.equal(toolCallSubject(editFile, { content: "secret" }), undefined);
});

test("a command that redacts every argument has no subject", () => {
  const fetch = command({ url: { type: "string" } }, { redactArguments: true });
  assert.equal(toolCallSubject(fetch, { url: "https://example.com" }), undefined);
  assert.equal(toolCallSubject(undefined, { path: "x" }), undefined);
});

test("an undeclared argument is not the subject", () => {
  assert.equal(toolCallSubject(writeFile, { extra: "x" }), undefined);
});

test("the subject is one bounded line with credential shapes scrubbed", () => {
  const long = toolCallSubject(bash, {
    command: `echo one\necho \u001b[2J${"x".repeat(500)}`,
  })!;
  assert.ok(!long.includes("\n") && !long.includes("\u001b"), long);
  assert.ok(Buffer.byteLength(long) <= TOOL_SUBJECT_MAX_BYTES, long);
  // Assembled at run time, so the repository's secret scan has no key to find.
  const key = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const scrubbed = toolCallSubject(bash, {
    command: `curl -H 'Authorization: Bearer ${key}'`,
  })!;
  assert.ok(!scrubbed.includes(key), scrubbed);
});

test("a command's exit status is its result status, even when the result is redacted", () => {
  assert.equal(toolResultStatus(bash, {}, "exit 1\nFAIL src/a.test.ts"), "exit 1");
  assert.equal(toolResultStatus(bash, {}, "exit 0\nok"), "exit 0");
  assert.equal(toolResultStatus(bash, {}, "exit by signal SIGTERM"), "exit by signal SIGTERM");
  assert.equal(
    toolResultStatus(bash, {}, "timed out after 30000ms (killed)\npartial"),
    "timed out after 30000ms (killed)",
  );
});

test("a redacted result contributes nothing but its exit status", () => {
  assert.equal(toolResultStatus(bash, {}, "error: cannot run command: secret"), undefined);
  assert.equal(toolResultStatus(bash, {}, "exit 1 and then the output"), undefined);
});

test("a tool's error reply is its result status", () => {
  const readFile = command({ path: { type: "string" } });
  assert.equal(
    toolResultStatus(readFile, { path: "missing.txt" }, "error: cannot read missing.txt: not found"),
    "error: cannot read missing.txt: not found",
  );
  assert.equal(toolResultStatus(readFile, {}, "file contents\nerror: not a status"), undefined);
  assert.equal(toolResultStatus(readFile, {}, { structured: true }), undefined);
});

test("an error reply that echoes a redacted argument is withheld", () => {
  const status = toolResultStatus(
    writeFile,
    { path: "a.md", content: "the secret body text" },
    "error: refused: the secret body text",
  )!;
  assert.ok(!status.includes("the secret body text"), status);
  assert.match(status, /withheld/);
});
