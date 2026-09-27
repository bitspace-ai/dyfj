import { assertEquals } from "@std/assert";
import { fakeIo } from "./fake-io.ts";

Deno.test("fakeIo captures each output stream separately", () => {
  const { io, stdout, stderr, raw } = fakeIo();
  io.out("delta");
  io.err("status line");
  io.errRaw?.("spinner");
  assertEquals(stdout, ["delta"]);
  assertEquals(stderr, ["status line"]);
  assertEquals(raw, ["spinner"]);
});

Deno.test("fakeIo answers readLine from the script, then EOF", async () => {
  const { io, prompts } = fakeIo(["first", "second"]);
  assertEquals(await io.readLine("> "), "first");
  assertEquals(await io.readLine("? "), "second");
  assertEquals(await io.readLine("> "), null);
  assertEquals(prompts, ["> ", "? ", "> "]);
});

Deno.test("fakeIo does not consume the caller's script", async () => {
  const lines = ["only"];
  const { io } = fakeIo(lines);
  await io.readLine("> ");
  assertEquals(lines, ["only"]);
});

Deno.test("fakeIo reports terminal state and close calls", () => {
  assertEquals(fakeIo().io.errIsTerminal, undefined);
  const fake = fakeIo([], { errIsTerminal: true });
  assertEquals(fake.io.errIsTerminal, true);
  assertEquals(fake.closed, 0);
  fake.io.close();
  assertEquals(fake.closed, 1);
});

Deno.test("fakeIo resolves an aborted read as null without consuming", async () => {
  const { io, prompts } = fakeIo(["kept"]);
  const controller = new AbortController();
  controller.abort();
  assertEquals(await io.readLine("> ", controller.signal), null);
  assertEquals(await io.readLine("> "), "kept");
  assertEquals(prompts, ["> ", "> "]);
});
