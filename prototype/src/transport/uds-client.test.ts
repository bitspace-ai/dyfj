import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "@std/assert";
import { connectUnixClient } from "./uds-client.ts";

// The unit lane grants no network access, so a connect attempt here would
// fail with a permission error: these cases pass only because an aborted
// signal short-circuits before the client dials.

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

Deno.test("connectUnixClient with an already-aborted signal rejects with its reason without dialing", async () => {
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  controller.abort(reason);
  const err = await rejection(
    connectUnixClient("/nonexistent/dyfj.sock", {}, controller.signal),
  );
  assertStrictEquals(err, reason);
});

Deno.test("connectUnixClient's default abort reason is an AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const err = await rejection(
    connectUnixClient("/nonexistent/dyfj.sock", {}, controller.signal),
  );
  assertInstanceOf(err, DOMException);
  assertEquals(err.name, "AbortError");
});
