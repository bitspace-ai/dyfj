import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchAuthContext } from "../contract/mod.ts";
import {
  MAX_CHARS_PER_SESSION,
  MAX_ENTRIES_PER_SESSION,
  MAX_TRACKED_SESSIONS,
  ToolHistoryStore,
  withheldToolResult,
} from "./tool-history.ts";

const LOOPBACK: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "user_consent",
};
const REMOTE: WorkbenchAuthContext = {
  ...LOOPBACK,
  transport: "remote",
  authnMechanism: "api_key",
};

test("a recorded result is read back in its session and clearance only", () => {
  const store = new ToolHistoryStore();
  store.toolHistory("s1", LOOPBACK).record("t1", "c1", "# pass 3");
  assert.equal(store.toolHistory("s1", LOOPBACK).lookup("t1", "c1"), "# pass 3");
  assert.equal(store.toolHistory("s1", REMOTE).lookup("t1", "c1"), undefined);
  assert.equal(
    store.toolHistory("s1", { ...LOOPBACK, authzBasis: "other" }).lookup("t1", "c1"),
    undefined,
  );
  assert.equal(store.toolHistory("s1", undefined).lookup("t1", "c1"), undefined);
  assert.equal(store.toolHistory("s2", LOOPBACK).lookup("t1", "c1"), undefined);
});

test("a session holds at most its character budget, dropping its oldest results first", () => {
  const store = new ToolHistoryStore();
  const history = store.toolHistory("s1", LOOPBACK);
  // Each entry counts its key too, so two halves overflow the budget.
  const half = "x".repeat(MAX_CHARS_PER_SESSION / 2);
  history.record("t1", "c1", half);
  history.record("t1", "c2", half);
  history.record("t1", "c3", "tail");
  assert.equal(history.lookup("t1", "c1"), undefined);
  assert.equal(history.lookup("t1", "c2"), half);
  assert.equal(history.lookup("t1", "c3"), "tail");
});

test("a result over the whole session budget is not kept", () => {
  const store = new ToolHistoryStore();
  const history = store.toolHistory("s1", LOOPBACK);
  history.record("t1", "c1", "kept");
  history.record("t1", "c2", "x".repeat(MAX_CHARS_PER_SESSION + 1));
  assert.equal(history.lookup("t1", "c1"), "kept");
  assert.equal(history.lookup("t1", "c2"), undefined);
});

test("the store tracks a bounded number of sessions, dropping the oldest", () => {
  const store = new ToolHistoryStore();
  for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
    store.toolHistory(`s${i}`, LOOPBACK).record("t1", "c1", `r${i}`);
  }
  assert.equal(store.toolHistory("s0", LOOPBACK).lookup("t1", "c1"), undefined);
  assert.equal(store.toolHistory("s1", LOOPBACK).lookup("t1", "c1"), "r1");
  assert.equal(
    store.toolHistory(`s${MAX_TRACKED_SESSIONS}`, LOOPBACK).lookup("t1", "c1"),
    `r${MAX_TRACKED_SESSIONS}`,
  );
});

test("the withheld line says the output is unavailable and carries no length", () => {
  const line = withheldToolResult("bash");
  assert.match(line, /not available/);
  assert.match(line, /This text is not the command's output/);
  assert.match(line, /Rerun the command/);
  assert.doesNotMatch(line, /\d/);
});

test("a session holds at most its entry count, however small the results", () => {
  const history = new ToolHistoryStore().toolHistory("s1", LOOPBACK);
  for (let i = 0; i <= MAX_ENTRIES_PER_SESSION; i++) {
    history.record("t1", `c${i}`, "");
  }
  assert.equal(history.lookup("t1", "c0"), undefined);
  assert.equal(history.lookup("t1", "c1"), "");
  assert.equal(history.lookup("t1", `c${MAX_ENTRIES_PER_SESSION}`), "");
});

test("a call id reused by a later turn keeps each turn's result apart", () => {
  const history = new ToolHistoryStore().toolHistory("s1", LOOPBACK);
  history.record("turn-1", "c1", "first");
  history.record("turn-2", "c1", "second");
  assert.equal(history.lookup("turn-1", "c1"), "first");
  assert.equal(history.lookup("turn-2", "c1"), "second");
});

test("the clearance scope counts toward the session's character budget", () => {
  const store = new ToolHistoryStore();
  const huge = { ...LOOPBACK, authnIssuerRef: "x".repeat(MAX_CHARS_PER_SESSION) };
  store.toolHistory("s1", huge).record("t1", "c1", "");
  assert.equal(store.toolHistory("s1", huge).lookup("t1", "c1"), undefined);
});
