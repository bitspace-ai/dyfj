import {
  assertMatch,
  assertNotMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { fakeIo } from "../../testing/fakes/fake-io.ts";
import { main } from "./main.ts";

describe("main usage errors", () => {
  it("a garbage --session exits 2 via the usage-error path", async () => {
    const { io, stderr } = fakeIo();
    const code = await main(["--session", "garbage-value"], io);
    assertStrictEquals(code, 2);
    assertMatch(stderr[0], /^dyfj: --session /);
    assertStringIncludes(stderr[0], "dyfj sessions");
    // The tidy path: usage message + help, never a stack trace.
    assertNotMatch(stderr.join("\n"), /^\s+at /m);
  });
});

describe("main --parse-check", () => {
  const silentIo = {
    out: () => {},
    err: () => {},
    readLine: () => Promise.resolve(null),
    close: () => {},
  };
  it("a valid invocation exits 0", async () => {
    assertStrictEquals(await main(["--parse-check", "status"], silentIo), 0);
    assertStrictEquals(await main(["--parse-check"], silentIo), 0);
  });
  it("a parser rejection exits 2", async () => {
    assertStrictEquals(await main(["--parse-check", "--bogus"], silentIo), 2);
    assertStrictEquals(
      await main(["--parse-check", "--tier", "3"], silentIo),
      2,
    );
  });
  it("a parser THROW also exits 2 — the contract is 0/2, not 0/2/crash", async () => {
    // normalizeSessionRef throws on an invalid ref rather than returning a
    // parse error; parse-check absorbs either rejection shape.
    assertStrictEquals(
      await main(["--parse-check", "--session", "garbage-value"], silentIo),
      2,
    );
  });
});
