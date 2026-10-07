// Unit tests for the header deadline every provider request carries.

import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ScriptedHttpTransport } from "../../testing/fakes/scripted-http-transport.ts";
import { fetchWithHeaderTimeout, ProviderUnreachableError } from "./mod.ts";

describe("fetchWithHeaderTimeout", () => {
  it("aborts a blackholed connection with a named error", async () => {
    const transport = new ScriptedHttpTransport([
      { respond: { withholdHeaders: true } },
    ]);
    const err = await assertRejects(() =>
      fetchWithHeaderTimeout(
        transport.fetch,
        "http://x/",
        {},
        { provider: "anthropic", slug: "test" },
        30,
      )
    );
    // The deadline's error is a classified provider failure: a DomainError
    // whose message the operator sees whole, naming the target and the
    // budget that elapsed.
    assertInstanceOf(err, ProviderUnreachableError);
    assertEquals(err.reason, "timeout");
    assertMatch(
      err.message,
      /anthropic\/test .*no response headers within 30ms/,
    );
  });

  it("passes a normal response through and clears the timer", async () => {
    const transport = new ScriptedHttpTransport([{ respond: { body: "hi" } }]);
    const response = await fetchWithHeaderTimeout(
      transport.fetch,
      "http://x/",
      {},
      { provider: "l", slug: "m" },
      30,
    );
    assertEquals(await response.text(), "hi");
  });

  it("non-abort failures pass through unchanged", async () => {
    // A function responder: the scripted vocabulary has no transport-level
    // rejection with a caller-chosen error.
    const transport = new ScriptedHttpTransport([{
      respond: () => Promise.reject(new Error("connection refused")),
    }]);
    await assertRejects(
      () =>
        fetchWithHeaderTimeout(
          transport.fetch,
          "http://x/",
          {},
          { provider: "l", slug: "m" },
          1000,
        ),
      Error,
      "connection refused",
    );
  });

  it("a buffered request names its own budget, not the streaming one", async () => {
    const transport = new ScriptedHttpTransport([
      { respond: { withholdHeaders: true } },
    ]);
    const err = await assertRejects(() =>
      fetchWithHeaderTimeout(
        transport.fetch,
        "http://x/",
        {},
        { provider: "anthropic", slug: "test" },
        30,
        "buffered",
      )
    );
    assertMatch(
      (err as Error).message,
      /anthropic\/test .*no response headers within 30ms \(buffered request exceeded its budget/,
    );
  });

  it("an earlier external abort wins when the header timer later fires before fetch rejects", async () => {
    const controller = new AbortController();
    let rejectFetch!: (reason: unknown) => void;
    // A function responder: the fetch must stay pending past both the
    // external abort and the header timer, and reject only when the test
    // says so, which the scripted vocabulary cannot sequence.
    const transport = new ScriptedHttpTransport([{
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = () => reject(request.signal?.reason);
        }),
    }]);
    const pending = fetchWithHeaderTimeout(
      transport.fetch,
      "http://x/",
      { signal: controller.signal },
      { provider: "l", slug: "m" },
      5,
    );

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    rejectFetch(controller.signal.reason);

    const rejection = await pending.then(() => undefined, (x) => x);
    assertStrictEquals(rejection, controller.signal.reason);
  });
});
