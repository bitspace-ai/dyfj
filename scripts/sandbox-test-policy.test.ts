import assert from "node:assert/strict";
import { test } from "node:test";
import { scanTest } from "./sandbox-test-policy.ts";

const probe = 'import { loopbackBindSkip } from "../prototype/testing/loopback-bind.ts";';
test("rejects hard-coded temp creation, including multiline, aliases and constants", () => {
  for (const source of [
    'mkdtemp("/tmp/example-")',
    'fs.mkdtempSync(join(\n"/tmp", "example-"))',
    'import { mkdtemp as make } from "node:fs/promises"; make("/tmp/x-")',
    'const base = "/tmp"; mkdtemp(join(base, "x-"))',
    'mkdtemp(`/tmp/example-${id}`)',
  ]) assert.equal(scanTest(source).length, 1, source);
});

test("ignores data, comments and portable temp creation", () => {
  assert.deepEqual(scanTest('const fixture = \'mkdtemp("/tmp/x-")\'; const cwd = "/tmp"; // mkdtemp("/tmp/x-")\nmkdtemp(join(tmpdir(), "x-"));'), []);
});

test("allows only a preceding explicit temp exception with a nonempty reason", () => {
  assert.deepEqual(scanTest('// sandbox-test-allow-tmp: exercises fixed /tmp policy\nmkdtemp("/tmp/x-")'), []);
  assert.equal(scanTest('// sandbox-test-allow-tmp:\nmkdtemp("/tmp/x-")').length, 1);
  assert.equal(scanTest('const data = "sandbox-test-allow-tmp: reason";\nmkdtemp("/tmp/x-")').length, 1);
});

test("rejects loopback listen calls in positional and options forms", () => {
  for (const source of [
    'server.listen(0, "127.0.0.1", resolve)',
    'server.listen({ port: 0, host: "::1" })',
    'const host = "localhost"; server.listen(0, host)',
    'server.listen(0)',
    'server.listen({ port: 0 })',
  ]) assert.equal(scanTest(source).length, 1, source);
});

test("Unix socket listen and source-code fixture strings are data for this rule", () => {
  assert.deepEqual(scanTest('server.listen("/tmp/example.sock"); const fixture = \'server.listen(0, "127.0.0.1")\';'), []);
});

test("requires a probe-backed enclosing test skip, not a token elsewhere", () => {
  assert.deepEqual(scanTest(probe + 'test("bind", { skip: await loopbackBindSkip() }, () => { server.listen(0, "127.0.0.1"); });'), []);
  assert.deepEqual(scanTest(probe + 'describe("bind", { skip: await loopbackBindSkip() }, () => { function bind() { server.listen(0, "127.0.0.1"); } });'), []);
  for (const source of [
    probe + 'await loopbackBindSkip(); server.listen(0, "127.0.0.1")',
    'test("bind", { skip: await loopbackBindSkip() }, () => server.listen(0, "127.0.0.1"))',
    probe + 'test("bind", { skip: false }, () => server.listen(0, "127.0.0.1"))',
  ]) assert.equal(scanTest(source).length, 1, source);
});
