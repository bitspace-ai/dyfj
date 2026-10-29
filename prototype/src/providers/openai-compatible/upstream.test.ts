// Reading who served a provider call, on both response paths.
//
// The provider names the upstream that answered and its own generation id at
// the top level of the response. Both are optional, both are provider-supplied
// text, and both are recorded only when they are genuinely strings: an absent
// field, a non-string, or a value that sanitizes to nothing is recorded as
// absent rather than as a placeholder.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PROVIDER_GENERATION_ID_BYTES,
  MAX_UPSTREAM_PROVIDER_BYTES,
  mergeUpstreamEvidence,
  readUpstreamEvidence,
  readUpstreamIdentifier,
} from "./upstream.ts";
import { parseOpenAIChatStreamLine } from "./stream.ts";
import { readOpenAIChatJson } from "./response.ts";

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

describe("readUpstreamIdentifier", () => {
  it("keeps a plain string", () => {
    assert.strictEqual(readUpstreamIdentifier("Together", 64), "Together");
  });

  it("returns undefined for an absent value, a non-string, and an empty string", () => {
    for (const value of [undefined, null, 42, true, {}, ["x"], ""]) {
      assert.strictEqual(readUpstreamIdentifier(value, 64), undefined);
    }
  });

  it("strips control characters, including a terminal escape", () => {
    assert.strictEqual(
      readUpstreamIdentifier("to\u001b[31mgether\u0007", 64),
      "to[31mgether",
    );
  });

  it("bounds by UTF-8 bytes without splitting a character", () => {
    const bounded = readUpstreamIdentifier("é".repeat(200), 101);
    assert.ok(bounded !== undefined);
    assert.ok(Buffer.byteLength(bounded, "utf8") <= 101);
    assert.ok(!bounded.includes("\uFFFD"));
  });

  it("returns undefined when nothing survives sanitizing", () => {
    assert.strictEqual(readUpstreamIdentifier("\u0000\u0007\u001b", 64), undefined);
  });
});

describe("readUpstreamEvidence", () => {
  it("reads both fields when the response carries them", () => {
    assert.deepStrictEqual(
      readUpstreamEvidence({ id: "gen-1730000000-abc", provider: "Together" }),
      { providerGenerationId: "gen-1730000000-abc", upstreamProvider: "Together" },
    );
  });

  it("omits a field that is absent or not a string", () => {
    assert.deepStrictEqual(readUpstreamEvidence({ provider: "Together" }), {
      upstreamProvider: "Together",
    });
    assert.deepStrictEqual(readUpstreamEvidence({ id: 7, provider: null }), {});
    assert.deepStrictEqual(readUpstreamEvidence({}), {});
  });

  it("bounds each field to its own column width", () => {
    const evidence = readUpstreamEvidence({
      provider: "p".repeat(500),
      id: "g".repeat(500),
    });
    assert.strictEqual(evidence.upstreamProvider?.length, MAX_UPSTREAM_PROVIDER_BYTES);
    assert.strictEqual(
      evidence.providerGenerationId?.length,
      MAX_PROVIDER_GENERATION_ID_BYTES,
    );
  });
});

describe("mergeUpstreamEvidence", () => {
  it("keeps the first value seen for each field", () => {
    assert.deepStrictEqual(
      mergeUpstreamEvidence(
        { upstreamProvider: "Together" },
        { upstreamProvider: "Fireworks", providerGenerationId: "gen-1" },
      ),
      { upstreamProvider: "Together", providerGenerationId: "gen-1" },
    );
  });

  it("survives a side that saw nothing", () => {
    const seen = { upstreamProvider: "Together" };
    assert.deepStrictEqual(mergeUpstreamEvidence(undefined, seen), seen);
    assert.deepStrictEqual(mergeUpstreamEvidence(seen, undefined), seen);
    assert.strictEqual(mergeUpstreamEvidence(undefined, undefined), undefined);
  });
});

describe("streamed frames", () => {
  it("carries the upstream named on a frame", () => {
    const event = parseOpenAIChatStreamLine(
      sseFrame({
        id: "gen-1730000000-abc",
        provider: "Together",
        choices: [{ delta: { content: "hi" } }],
      }),
    );
    assert.deepStrictEqual(event?.upstream, {
      providerGenerationId: "gen-1730000000-abc",
      upstreamProvider: "Together",
    });
  });

  it("carries no upstream for a frame that names none", () => {
    const event = parseOpenAIChatStreamLine(
      sseFrame({ choices: [{ delta: { content: "hi" } }] }),
    );
    assert.strictEqual(Object.hasOwn(event ?? {}, "upstream"), false);
  });

  it("ignores a non-string provider on a frame", () => {
    const event = parseOpenAIChatStreamLine(
      sseFrame({ provider: { name: "Together" }, choices: [{ delta: {} }] }),
    );
    assert.strictEqual(event?.upstream, undefined);
  });

  it("ignores the terminal [DONE] frame", () => {
    assert.deepStrictEqual(parseOpenAIChatStreamLine("data: [DONE]"), {
      done: true,
    });
  });
});

describe("buffered response", () => {
  const now = () => 0;
  const read = (body: unknown) =>
    readOpenAIChatJson(
      new Response(JSON.stringify(body)),
      now,
      0,
      0,
    );

  it("carries the upstream named by the response", async () => {
    const result = await read({
      id: "gen-1730000000-abc",
      provider: "Together",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });
    assert.deepStrictEqual(result.upstream, {
      providerGenerationId: "gen-1730000000-abc",
      upstreamProvider: "Together",
    });
  });

  it("omits the upstream for a response that names none", async () => {
    const result = await read({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    assert.strictEqual(Object.hasOwn(result, "upstream"), false);
  });

  it("records nothing for a non-string id or provider", async () => {
    const result = await read({
      id: 12,
      provider: ["Together"],
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    assert.strictEqual(result.upstream, undefined);
  });

  it("sanitizes and bounds a hostile value", async () => {
    const result = await read({
      id: "gen-\u0000" + "g".repeat(400),
      provider: "\u001b[2J" + "p".repeat(200),
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    // The ESC byte goes; the rest of the escape sequence is inert text, so it
    // occupies the byte budget rather than being skipped.
    const provider = result.upstream?.upstreamProvider ?? "";
    assert.ok(Buffer.byteLength(provider, "utf8") <= MAX_UPSTREAM_PROVIDER_BYTES);
    assert.strictEqual(provider, ("[2J" + "p".repeat(200)).slice(
      0,
      MAX_UPSTREAM_PROVIDER_BYTES,
    ));
    const generationId = result.upstream?.providerGenerationId ?? "";
    assert.ok(
      Buffer.byteLength(generationId, "utf8") <=
        MAX_PROVIDER_GENERATION_ID_BYTES,
    );
    assert.ok(generationId.startsWith("gen-"));
    assert.ok(!generationId.includes("\u0000"));
  });
});
