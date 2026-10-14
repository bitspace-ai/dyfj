// The fetch-style server's backpressure wait: a response that stops draining
// because its client went away must not leave the body pump waiting forever.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { drainOrClose } from "./fetch-server.ts";

type Outgoing = Pick<ServerResponse, "once" | "off">;

function outgoing(): EventEmitter & Outgoing {
  return new EventEmitter() as EventEmitter & Outgoing;
}

/** Whether `promise` has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe("drainOrClose", () => {
  it("settles on drain and drops its close listener", async () => {
    const response = outgoing();
    const wait = drainOrClose(response);
    response.emit("drain");
    assert.equal(await settled(wait), true);
    assert.equal(response.listenerCount("close"), 0);
    assert.equal(response.listenerCount("drain"), 0);
  });

  it("settles on close, when the client left before draining", async () => {
    const response = outgoing();
    const wait = drainOrClose(response);
    response.emit("close");
    assert.equal(await settled(wait), true);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("close"), 0);
  });
});
