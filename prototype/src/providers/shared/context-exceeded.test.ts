import { assertEquals, assertStrictEquals } from "@std/assert";
import { classifyContextExceeded } from "./context-exceeded.ts";

const LLAMA_SERVER = JSON.stringify({
  error: {
    code: 400,
    message: "request (82366 tokens) exceeds the available context size " +
      "(32768 tokens), try increasing it",
    type: "exceed_context_size_error",
  },
});

Deno.test("classifyContextExceeded: llama-server's rejection, with its counts", () => {
  assertEquals(classifyContextExceeded(400, LLAMA_SERVER), {
    requestedTokens: 82366,
    limitTokens: 32768,
  });
});

Deno.test("classifyContextExceeded: OpenAI's context_length_exceeded, with its counts", () => {
  const body = JSON.stringify({
    error: {
      message: "This model's maximum context length is 128000 tokens. " +
        "However, your messages resulted in 130123 tokens. Please reduce " +
        "the length of the messages.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
  assertEquals(classifyContextExceeded(400, body), {
    requestedTokens: 130123,
    limitTokens: 128000,
  });
});

Deno.test("classifyContextExceeded: Anthropic's prompt-too-long, with its counts", () => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 213456 tokens > 200000 maximum",
    },
  });
  assertEquals(classifyContextExceeded(400, body), {
    requestedTokens: 213456,
    limitTokens: 200000,
  });
});

Deno.test("classifyContextExceeded: Gemini's input-token-count rejection, with its counts", () => {
  const body = JSON.stringify({
    error: {
      code: 400,
      message: "The input token count (1234567) exceeds the maximum number " +
        "of tokens allowed (1048576).",
      status: "INVALID_ARGUMENT",
    },
  });
  assertEquals(classifyContextExceeded(400, body), {
    requestedTokens: 1234567,
    limitTokens: 1048576,
  });
});

Deno.test("classifyContextExceeded: a rejection without counts still classifies, with none reported", () => {
  assertEquals(
    classifyContextExceeded(413, "the prompt exceeds the context length"),
    {},
  );
  assertEquals(classifyContextExceeded(422, "context_length_exceeded"), {});
});

Deno.test("classifyContextExceeded: an unrelated 400 is not overflow", () => {
  assertStrictEquals(
    classifyContextExceeded(
      400,
      JSON.stringify({ error: { message: "model 'nope' not found" } }),
    ),
    null,
  );
  assertStrictEquals(
    classifyContextExceeded(400, "Invalid parameter: temperature"),
    null,
  );
});

Deno.test("classifyContextExceeded: a server error is never overflow, whatever it says", () => {
  assertStrictEquals(classifyContextExceeded(500, LLAMA_SERVER), null);
  assertStrictEquals(classifyContextExceeded(503, "context length"), null);
});

Deno.test("classifyContextExceeded: absurd counts are dropped, the verdict stands", () => {
  const body = "request (999999999999 tokens) exceeds the available " +
    "context size (32768 tokens)";
  assertEquals(classifyContextExceeded(400, body), {
    requestedTokens: undefined,
    limitTokens: 32768,
  });
});
