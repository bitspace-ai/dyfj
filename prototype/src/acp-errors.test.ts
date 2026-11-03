import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  AcpAuthenticationRequiredError,
  AcpRunnerError,
  agentRequestFailure,
  promptFailure,
} from "./acp-errors.ts";

const profile = { slug: "codex-chatgpt", requiredAuthentication: "chat-gpt" } as const;

test("an agent's JSON-RPC error is named by its code, never its text", () => {
  const error = agentRequestFailure(
    new RequestError(-32603, "secret service text"),
    "prompt",
    profile,
  );
  assert.ok(error instanceof AcpRunnerError);
  assert.match(error.message, /JSON-RPC -32603/);
  assert.ok(!error.message.includes("secret service text"));
});

test("an agent's auth_required asks for a sign-in", () => {
  assert.ok(
    agentRequestFailure(new RequestError(-32000, "auth"), "session", profile) instanceof
      AcpAuthenticationRequiredError,
  );
});

test("a local error with a numeric code is not taken for the agent's answer", () => {
  const abort = new DOMException("The operation was aborted", "AbortError");
  assert.equal(abort.code, 20);
  assert.equal(agentRequestFailure(abort, "prompt", profile), undefined);
  assert.equal(
    agentRequestFailure(Object.assign(new Error("local"), { code: 7 }), "session", profile),
    undefined,
  );
  assert.doesNotMatch(promptFailure(abort, profile).message, /JSON-RPC/);
});
