import assert from "node:assert/strict";
import { fakeIo } from "./fake-io.ts";

Deno.test("fakeIo captures each output stream separately", () => {
  const { io, stdout, stderr, raw } = fakeIo();
  io.out("delta");
  io.err("status line");
  io.errRaw?.("spinner");
  assert.deepStrictEqual(stdout, ["delta"]);
  assert.deepStrictEqual(stderr, ["status line"]);
  assert.deepStrictEqual(raw, ["spinner"]);
});

Deno.test("fakeIo answers readLine from the script, then EOF", async () => {
  const { io, prompts } = fakeIo(["first", "second"]);
  assert.deepStrictEqual(await io.readLine("> "), "first");
  assert.deepStrictEqual(await io.readLine("? "), "second");
  assert.deepStrictEqual(await io.readLine("> "), null);
  assert.deepStrictEqual(prompts, ["> ", "? ", "> "]);
});

Deno.test("fakeIo does not consume the caller's script", async () => {
  const lines = ["only"];
  const { io } = fakeIo(lines);
  await io.readLine("> ");
  assert.deepStrictEqual(lines, ["only"]);
});

Deno.test("fakeIo reports terminal state and close calls", () => {
  assert.deepStrictEqual(fakeIo().io.errIsTerminal, undefined);
  const fake = fakeIo([], { errIsTerminal: true });
  assert.deepStrictEqual(fake.io.errIsTerminal, true);
  assert.deepStrictEqual(fake.closed, 0);
  fake.io.close();
  assert.deepStrictEqual(fake.closed, 1);
});

Deno.test("fakeIo resolves an aborted read as null without consuming", async () => {
  const { io, prompts } = fakeIo(["kept"]);
  const controller = new AbortController();
  controller.abort();
  assert.deepStrictEqual(await io.readLine("> ", controller.signal), null);
  assert.deepStrictEqual(await io.readLine("> "), "kept");
  assert.deepStrictEqual(prompts, ["> ", "> "]);
});
