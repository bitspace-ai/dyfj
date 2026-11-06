// Tests for `workbench.models` (`models.ts`): it registers only with a
// catalog port, the policy allows it without a prompt, and its listing
// shows each row's slug, provider, tier and prices. Pure: the port is a fake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolCatalog } from "../catalog.ts";
import type { CommandCall } from "../definition.ts";
import { invokeCommand } from "../invoke.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import {
  type CatalogListing,
  type CatalogModelRow,
  formatCatalogListing,
  MAX_LISTED_MODELS,
} from "./models.ts";

const HOSTED: CatalogModelRow = {
  slug: "hosted-large",
  displayName: "Hosted Large",
  provider: "anthropic",
  tier: 2,
  costInput: 3,
  costOutput: 15,
  routable: true,
  local: false,
  modality: "frontier-hosted",
};

const LOCAL: CatalogModelRow = {
  slug: "local-chat",
  displayName: "Local Chat",
  provider: "lmstudio",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  routable: true,
  local: true,
  modality: "local",
};

function call(args: Record<string, unknown> = {}): CommandCall {
  return {
    commandId: "workbench.models",
    callId: "call-models",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
  };
}

function catalog(listing: CatalogListing) {
  return buildToolCatalog({ listModels: async () => listing }, {});
}

describe("workbench.models", () => {
  it("registers only when the catalog port is supplied", () => {
    assert.deepStrictEqual(
      buildToolCatalog({}, {}).list().map((c) => c.id),
      ["memory.read"],
    );
    assert.deepStrictEqual(
      catalog({ models: [] }).list().map((c) => c.id),
      ["memory.read", "workbench.models"],
    );
  });

  it("is allowed without a prompt under strict, on any transport", () => {
    const command = catalog({ models: [] }).lookup("workbench.models")!;
    for (const loopback of [true, false]) {
      const verdict = evaluateCommandPolicy(command, call(), {
        permissionLevel: "strict",
        loopback,
      });
      assert.strictEqual(verdict.decision, "allow");
    }
  });

  it("refuses an argument it does not declare", () => {
    const command = catalog({ models: [] }).lookup("workbench.models")!;
    const verdict = evaluateCommandPolicy(command, call({ all: true }));
    assert.strictEqual(verdict.decision, "deny");
  });

  it("lists slug, provider, tier and prices for each row", async () => {
    const result = await invokeCommand(
      catalog({ models: [HOSTED, LOCAL] }),
      call(),
    );
    assert.ok(result.decision === "allow" && !result.isError);
    const lines = String(result.result).split("\n");
    assert.match(lines[0]!, /^slug \| provider \| tier/);
    assert.strictEqual(
      lines[1],
      "hosted-large | anthropic | t2 | frontier-hosted | $3 | $15 |  | Hosted Large",
    );
    assert.strictEqual(
      lines[2],
      "local-chat | lmstudio | t0 | local | $0 | $0 | local | Local Chat",
    );
  });
});

describe("formatCatalogListing", () => {
  it("marks an unpriced row as not routable", () => {
    const text = formatCatalogListing({
      models: [{ ...HOSTED, routable: false, costInput: 0, costOutput: 0 }],
    });
    assert.match(text, /\| unpriced, not routable \|/);
  });

  it("says when only the built-in local rows are listed, without a reason", () => {
    const text = formatCatalogListing({ models: [LOCAL], fallback: true });
    assert.match(text.split("\n")[0]!, /could not be loaded/);
    assert.match(text, /local-chat/);
  });

  it("shows a small positive price as itself, not as zero", () => {
    const text = formatCatalogListing({
      models: [{ ...HOSTED, costInput: 0.004, costOutput: 0.0125 }],
    });
    assert.match(text, /\| \$0\.004 \| \$0\.0125 \|/);
  });

  it("a catalog string cannot add a row or a column", () => {
    const text = formatCatalogListing({
      models: [{ ...HOSTED, displayName: "Evil\nfake-row | anthropic | t0" }],
    });
    const lines = text.split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1]!.split(" | ").length, 8);
  });

  it("prints a long slug whole, so it stays usable as a model id", () => {
    const slug = `vendor/${"x".repeat(240)}`;
    const text = formatCatalogListing({ models: [{ ...HOSTED, slug }] });
    assert.ok(text.split("\n")[1]!.startsWith(`${slug} | `));
  });

  it("lists at most MAX_LISTED_MODELS rows and counts the rest", () => {
    const models = Array.from(
      { length: MAX_LISTED_MODELS + 3 },
      (_, i) => ({ ...LOCAL, slug: `m${i}` }),
    );
    const lines = formatCatalogListing({ models }).split("\n");
    assert.strictEqual(lines.length, 1 + MAX_LISTED_MODELS + 1);
    assert.strictEqual(lines.at(-1), "3 more models are not listed.");
  });

  it("counts rows the caller left out of a shortened listing", () => {
    const text = formatCatalogListing({ models: [LOCAL], total: 4 });
    assert.strictEqual(text.split("\n").at(-1), "3 more models are not listed.");
  });

  it("an empty subset of a non-empty catalog counts the rows, not 'no models'", () => {
    assert.strictEqual(
      formatCatalogListing({ models: [], total: 4 }).split("\n").at(-1),
      "4 more models are not listed.",
    );
  });

  it("says so when the catalog has no rows", () => {
    assert.strictEqual(
      formatCatalogListing({ models: [] }),
      "The model catalog has no active models.",
    );
  });
});
