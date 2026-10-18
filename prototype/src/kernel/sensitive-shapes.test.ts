import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSensitiveShape, scrubSensitiveShapes } from "./sensitive-shapes.ts";

test("containsSensitiveShape recognises credential shapes and ignores look-alikes", () => {
  assert.equal(containsSensitiveShape(`key sk-${"a".repeat(20)}`), true);
  assert.equal(
    containsSensitiveShape("github_pat_abcdefghijklmnopqrstuvwxyz0123456789"),
    true,
  );
  assert.equal(containsSensitiveShape("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(containsSensitiveShape("token_count=12345678"), false);
  assert.equal(containsSensitiveShape("Could not find issue \"BIT-99999\""), false);
});

test("scrubSensitiveShapes replaces every credential shape and keeps the rest", () => {
  const scrubbed = scrubSensitiveShapes(
    `upstream said sk-${"a".repeat(20)} and AKIA${"B".repeat(16)}; retry later`,
  );
  assert.equal(scrubbed, "upstream said [scrubbed] and [scrubbed]; retry later");
});

test("scrubSensitiveShapes scrubs a key=value credential and a bearer header", () => {
  const scrubbed = scrubSensitiveShapes(
    "bad request: api_key=abcdef0123456789 sent with Bearer abcdefghijklmnopqrstuvwxyz0123",
  );
  assert.ok(!scrubbed.includes("abcdef0123456789"), scrubbed);
  assert.ok(!scrubbed.includes("abcdefghijklmnopqrstuvwxyz0123"), scrubbed);
  assert.ok(scrubbed.startsWith("bad request:"), scrubbed);
});

test("scrubSensitiveShapes leaves text with no credential shape unchanged", () => {
  const text = "Error: Provide exactly one of issueId, projectId";
  assert.equal(scrubSensitiveShapes(text), text);
});

test("both password spellings are recognised and scrubbed", () => {
  for (const key of ["passwd", "password"]) {
    const text = `login failed: ${key}=abcdefgh12345678`;
    assert.equal(containsSensitiveShape(text), true, key);
    assert.ok(!scrubSensitiveShapes(text).includes("abcdefgh12345678"), key);
  }
});
