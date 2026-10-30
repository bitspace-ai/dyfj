import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPublishConfig, type PublishConfig } from "../config/mod.ts";
import { buildToolCatalog, PublishTickets, RootAnchors } from "../tools/mod.ts";
import type { PublishCatalogPorts } from "../tools/mod.ts";

const CONFIG: PublishConfig = {
  preGate: ["./pre-gate", "--range={range}"],
  gate: ["./gate", "--report={report}"],
  reportPath: "/tmp/dyfj-publish/{ticket}.log",
  gateTimeoutMs: 600_000,
  ticketTtlMs: 3_600_000,
};

/** The catalog a turn builds, with the publish ports the server may pass. */
function catalog(publish: Omit<PublishCatalogPorts, "sessionId"> | undefined) {
  return buildToolCatalog(
    {
      rootAnchors: new RootAnchors(),
      ...(publish === undefined
        ? {}
        : {
          publish: { ...publish, sessionId: "session-1" },
        }),
    },
    { workspaceRoot: "/workspace" },
  );
}

const PUBLISH_IDS = ["publish/cancel", "publish/start", "publish/status"];

describe("publish tools at the composition root", () => {
  it("registers nothing when [publish] is absent", async () => {
    const loaded = await loadPublishConfig({
      env: { get: () => undefined },
      readTextFile: () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
      parseToml: () => ({}),
    });
    assert.strictEqual(loaded, null);
    const ids = catalog(undefined).list().map((command) => command.id);
    for (const id of PUBLISH_IDS) {
      assert.ok(!ids.includes(id), `${id} must not be registered`);
    }
  });

  it("registers all three when the section is present", () => {
    const ids = catalog({
      config: CONFIG,
      tickets: new PublishTickets({ ttlMs: CONFIG.ticketTtlMs }),
      policy: { net: [], run: [], env: [], dolt: null },
      resolveImplementer: () => Promise.resolve(""),
    }).list().map((command) => command.id);
    for (const id of PUBLISH_IDS) {
      assert.ok(ids.includes(id), `${id} must be registered`);
    }
  });

  it("registers nothing when no workspace root resolves", () => {
    // Without a root there is no repository to publish, so the tools stay out
    // rather than appearing and failing on every call.
    const ids = buildToolCatalog(
      {
        rootAnchors: new RootAnchors(),
        publish: {
          config: CONFIG,
          tickets: new PublishTickets({ ttlMs: CONFIG.ticketTtlMs }),
          policy: { net: [], run: [], env: [], dolt: null },
          sessionId: "session-1",
          resolveImplementer: () => Promise.resolve(""),
        },
      },
      {},
    ).list().map((command) => command.id);
    for (const id of PUBLISH_IDS) {
      assert.ok(!ids.includes(id), `${id} must not be registered`);
    }
  });
});
