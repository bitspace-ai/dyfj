import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedDnsResolver } from "../../../testing/fakes/scripted-dns-resolver.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { composeRuntimePolicy, guardedFetch } from "../../config/mod.ts";
import { CommandExecutionError } from "../definition.ts";
import { safeFetchDocument } from "./web-document.ts";

// Resolves the test host to a public address, so the address check passes
// and the fetch seam is what decides.
const dns = () =>
  new ScriptedDnsResolver({
    "blocked.example.test": { A: ["93.184.216.34"], AAAA: [] },
    "allowed.example.test": { A: ["93.184.216.34"], AAAA: [] },
  });

describe("safeFetchDocument egress", () => {
  it("refuses a public host outside the network policy by default", async () => {
    await assert.rejects(
      safeFetchDocument(
        "https://blocked.example.test/page?token=abc",
        undefined,
        false,
        dns(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CommandExecutionError);
        assert.match(
          error.message,
          /network egress to "blocked\.example\.test:443" refused/,
        );
        assert.doesNotMatch(error.message, /token=abc/);
        return true;
      },
    );
  });

  it("fetches a host the policy allows", async () => {
    const transport = new ScriptedHttpTransport([{
      respond: { headers: { "content-type": "text/plain" }, body: "hello" },
    }]);
    const policy = {
      ...composeRuntimePolicy(),
      net: ["allowed.example.test:443"],
    };
    const doc = await safeFetchDocument(
      "https://allowed.example.test/page",
      guardedFetch(policy, transport.fetchLike),
      false,
      dns(),
    );
    assert.strictEqual(doc.text, "hello");
  });
});
