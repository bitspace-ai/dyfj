import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL_SUBJECT_MAX_BYTES,
  toolCallSubject,
  toolResultStatus,
} from "./call-subject.ts";
import type { CommandDefinition } from "./definition.ts";
import { describeTimeout } from "./builtin/bounded-process.ts";

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
const bash = {
  ...command({ command: { type: "string" }, cwd: { type: "string" } }, { redactResult: true }),
  id: "bash",
} as CommandDefinition;

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
  assert.equal(toolResultStatus(bash, {}, "exit 1 and then the output"), undefined);
  assert.equal(toolResultStatus(bash, {}, "the output\nexit 0"), undefined);
});

// A command whose runner threw, whose cwd was refused, or whose arguments
// failed validation replies `error: …` and never ran. Read as no status, the
// call showed as a success. The reply may echo redacted content, so the
// status is fixed text.
test("a redacted error reply is a fixed status that says the command did not run", () => {
  for (const reply of [
    "error: cannot run command: spawn EACCES secret-token",
    "error: cwd is outside the workspace: /private/secret",
    "error: empty command",
  ]) {
    assert.equal(toolResultStatus(bash, {}, reply), "did not run");
  }
});

// Only a command's result opens with a runtime-written exit status. A file
// whose first line reads `exit 1` is content, not a status.
test("an exit status line is a status only for bash and git", () => {
  const readFile = { ...command({ path: { type: "string" } }), id: "read_file" } as CommandDefinition;
  assert.equal(toolResultStatus(readFile, {}, "exit 1\nthe rest of the file"), undefined);
  assert.equal(toolResultStatus(readFile, {}, "note: x\nexit 1"), undefined);
  const git = { ...bash, id: "git" } as CommandDefinition;
  assert.equal(toolResultStatus(git, {}, "note: run from a subdirectory\nexit 1"), "exit 1");
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

// The headers the executor really writes, not hand-copied ones: a parser
// written against a remembered form (`timed out after 30s`) shows a timed-out
// check as a success.
test("every timeout header describeTimeout writes is a result status", () => {
  const headers = [
    describeTimeout(3000),
    describeTimeout(3000, { group: "stopped", exited: true, outputClosed: true }),
    describeTimeout(3000, { group: "survived", exited: false, outputClosed: false }),
    describeTimeout(3000, { group: "unavailable", exited: true, outputClosed: false }),
  ];
  for (const header of headers) {
    assert.equal(toolResultStatus(bash, {}, `${header}\npartial output`), header);
  }
});

test("a git status line after the subdirectory notice is still the status", () => {
  const git = { ...command({ subcommand: { type: "string" } }), id: "git" } as CommandDefinition;
  const notice = "note: the workspace is a subdirectory of this repository, so this " +
    "commit records every staged change in it, including paths outside the workspace.";
  assert.equal(toolResultStatus(git, {}, `${notice}\nexit 1\nnothing to commit`), "exit 1");
  assert.equal(toolResultStatus(git, {}, "note: something\nnot a status"), undefined);
});
