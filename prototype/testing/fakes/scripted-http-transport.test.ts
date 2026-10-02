import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { httpTransportConformance } from "../conformance/http-transport.ts";
import {
  type RecordedRequest,
  ScriptedHttpTransport,
} from "./scripted-http-transport.ts";

httpTransportConformance({
  name: "ScriptedHttpTransport",
  make(script) {
    const fake = new ScriptedHttpTransport(
      script.map((respond) => ({ respond })),
    );
    return Promise.resolve({
      transport: fake.fetch,
      baseUrl: "http://fake.invalid",
      requests: (): readonly RecordedRequest[] => fake.requests,
      close: () => Promise.resolve(),
    });
  },
});

httpTransportConformance({
  name: "ScriptedHttpTransport.fetchLike",
  make(script) {
    const fake = new ScriptedHttpTransport(
      script.map((respond) => ({ respond })),
    );
    return Promise.resolve({
      transport: (url: string, init: RequestInit) => fake.fetchLike(url, init),
      baseUrl: "http://fake.invalid",
      requests: (): readonly RecordedRequest[] => fake.requests,
      close: () => Promise.resolve(),
    });
  },
});

Deno.test("ScriptedHttpTransport runs each exchange's request assertions", async () => {
  const fake = new ScriptedHttpTransport([{
    expect: (request) => assertEquals(request.body, "expected"),
    respond: { body: "ok" },
  }]);
  await assertRejects(
    () => fake.fetch("http://fake.invalid/", { method: "POST", body: "other" }),
    Error,
    "Values are not equal",
  );
});

Deno.test("ScriptedHttpTransport rejects a call beyond its script", async () => {
  const fake = new ScriptedHttpTransport();
  await assertRejects(
    () => fake.fetch("http://fake.invalid/x", { method: "POST" }),
    Error,
    "unexpected request POST http://fake.invalid/x",
  );
});

Deno.test("ScriptedHttpTransport reports unused exchanges", async () => {
  const fake = new ScriptedHttpTransport([
    { respond: { body: "a" } },
    { respond: { body: "b" } },
  ]);
  await (await fake.fetch("http://fake.invalid/", {})).text();
  assertEquals(fake.remaining, 1);
  assertThrows(() => fake.assertDone(), Error, "1 scripted exchange(s) unused");
});

Deno.test("ScriptedHttpTransport passes a function responder's Response through", async () => {
  const fake = new ScriptedHttpTransport([{
    respond: (request) => new Response(`echo ${request.body}`),
  }]);
  const response = await fake.fetch("http://fake.invalid/", { body: "hi" });
  assertEquals(await response.text(), "echo hi");
  fake.assertDone();
});

Deno.test("ScriptedHttpTransport.fetchLike reads a Request input into the port's shape", async () => {
  const fake = new ScriptedHttpTransport([{ respond: { body: "ok" } }]);
  const response = await fake.fetchLike(
    new Request("http://fake.invalid/r", {
      method: "POST",
      headers: { "x-fixture": "1" },
      body: "payload",
      redirect: "error",
    }),
  );
  assertEquals(await response.text(), "ok");
  const [request] = fake.requests;
  assertEquals(request?.method, "POST");
  assertEquals(request?.url, "http://fake.invalid/r");
  assertEquals(request?.headers["x-fixture"], "1");
  assertEquals(request?.body, "payload");
  assertEquals(request?.redirect, "error");
});
