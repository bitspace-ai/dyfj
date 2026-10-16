import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertConnectAllowed,
  assertEgressAllowed,
  EgressRefusedError,
  egressTarget,
  guardedFetch,
} from "./egress.ts";
import { composeRuntimePolicy } from "./runtime-policy.ts";

// Assembled at runtime so the secret scans never read it as a real
// credential-bearing URL in tracked source.
const CREDENTIAL_URL = ["https://user", "hunter2@evil.example.test/p?token=abc"]
  .join(":");

const policy = composeRuntimePolicy({
  mcpServers: [{ url: "https://mcp.example.test/mcp" } as never],
  dolt: { host: "127.0.0.1", port: 3306 },
});

type Call = { url: string; init: RequestInit | undefined };

function scripted(
  responses: Record<string, () => Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const respond = responses[url];
    if (respond === undefined) throw new Error(`unscripted ${url}`);
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

describe("egressTarget", () => {
  it("names host:port with the protocol's default port", () => {
    assert.strictEqual(
      egressTarget("https://api.anthropic.com/v1/messages"),
      "api.anthropic.com:443",
    );
    assert.strictEqual(egressTarget("http://localhost/x"), "localhost:80");
    assert.strictEqual(
      egressTarget(new URL("http://127.0.0.1:11434/api")),
      "127.0.0.1:11434",
    );
    assert.strictEqual(egressTarget("http://[::1]:8080/"), "[::1]:8080");
  });

  it("drops credentials and path, so neither can reach an error", () => {
    assert.strictEqual(
      egressTarget(CREDENTIAL_URL),
      "evil.example.test:443",
    );
  });

  it("cannot decide a non-http(s) or malformed URL, so returns null", () => {
    assert.strictEqual(egressTarget("data:text/plain,hi"), null);
    assert.strictEqual(egressTarget("file:///etc/passwd"), null);
    assert.strictEqual(egressTarget("not a url"), null);
  });
});

describe("assertEgressAllowed", () => {
  it("allows a static provider host and a configured MCP host", () => {
    assertEgressAllowed(policy, "https://api.openai.com/v1/chat/completions");
    assertEgressAllowed(policy, "https://mcp.example.test/mcp");
  });

  it("refuses a host outside the policy, naming the host and where to configure it", () => {
    assert.throws(
      () =>
        assertEgressAllowed(policy, CREDENTIAL_URL),
      (error: unknown) => {
        assert.ok(error instanceof EgressRefusedError);
        assert.strictEqual(error.target, "evil.example.test:443");
        assert.match(error.message, /"evil\.example\.test:443"/);
        assert.match(error.message, /\[\[mcp\.servers\]\]/);
        assert.match(error.message, /\[network\] allow in ~\/\.dyfj\/config\.toml/);
        assert.doesNotMatch(error.message, /runtime-policy/);
        assert.doesNotMatch(error.message, /hunter2|token=abc|\/p/);
        return true;
      },
    );
  });

  it("refuses a known host on a port the policy does not name", () => {
    assert.throws(
      () => assertEgressAllowed(policy, "https://api.openai.com:8443/"),
      EgressRefusedError,
    );
  });

  it("refuses a URL it cannot decide", () => {
    assert.throws(
      () => assertEgressAllowed(policy, "file:///etc/passwd"),
      (error: unknown) =>
        error instanceof EgressRefusedError &&
        /cannot be checked/.test(error.message) &&
        !error.message.includes("/etc/passwd"),
    );
  });
});

describe("guardedFetch", () => {
  it("refuses a disallowed host before the delegate is called", async () => {
    const delegate = scripted({});
    await assert.rejects(
      guardedFetch(policy, delegate.fetch)("https://evil.example.test/"),
      EgressRefusedError,
    );
    assert.strictEqual(delegate.calls.length, 0);
  });

  it("passes an allowed request through with manual redirect handling", async () => {
    const delegate = scripted({
      "https://api.openai.com/v1/models": () => new Response("ok"),
    });
    const response = await guardedFetch(policy, delegate.fetch)(
      "https://api.openai.com/v1/models",
      { method: "GET" },
    );
    assert.strictEqual(await response.text(), "ok");
    assert.strictEqual(delegate.calls[0].init?.redirect, "manual");
  });

  it("rechecks each redirect hop and refuses one that leaves the policy", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () =>
        redirect(302, "https://api.anthropic.com/b"),
      "https://api.anthropic.com/b": () =>
        redirect(307, "https://evil.example.test/c"),
    });
    await assert.rejects(
      guardedFetch(policy, delegate.fetch)("https://api.openai.com/a"),
      (error: unknown) =>
        error instanceof EgressRefusedError &&
        error.target === "evil.example.test:443",
    );
    assert.deepStrictEqual(delegate.calls.map((call) => call.url), [
      "https://api.openai.com/a",
      "https://api.anthropic.com/b",
    ]);
  });

  it("follows an allowed redirect, resolving a relative location", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () => redirect(301, "/b"),
      "https://api.openai.com/b": () => new Response("followed"),
    });
    const response = await guardedFetch(policy, delegate.fetch)(
      "https://api.openai.com/a",
    );
    assert.strictEqual(await response.text(), "followed");
  });

  it("drops Authorization on a cross-origin hop, as fetch does", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () =>
        redirect(302, "https://api.anthropic.com/b"),
      "https://api.anthropic.com/b": () => new Response("ok"),
    });
    await guardedFetch(policy, delegate.fetch)("https://api.openai.com/a", {
      headers: { Authorization: "Bearer secret", "X-Keep": "1" },
    });
    const hop = new Headers(delegate.calls[1].init?.headers);
    assert.strictEqual(hop.get("authorization"), null);
    assert.strictEqual(hop.get("x-keep"), "1");
  });

  it("turns a 303 into a bodiless GET", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () => redirect(303, "/b"),
      "https://api.openai.com/b": () => new Response("ok"),
    });
    await guardedFetch(policy, delegate.fetch)("https://api.openai.com/a", {
      method: "POST",
      body: "payload",
    });
    assert.strictEqual(delegate.calls[1].init?.method, "GET");
    assert.strictEqual(delegate.calls[1].init?.body, undefined);
  });

  it("honours redirect: error and redirect: manual from the caller", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () => redirect(302, "/b"),
    });
    const guarded = guardedFetch(policy, delegate.fetch);
    await assert.rejects(
      guarded("https://api.openai.com/a", { redirect: "error" }),
      TypeError,
    );
    const manual = await guarded("https://api.openai.com/a", {
      redirect: "manual",
    });
    assert.strictEqual(manual.status, 302);
  });

  it("refuses a redirect it would have to replay a stream body for", async () => {
    const delegate = scripted({
      "https://api.openai.com/a": () => redirect(307, "/b"),
    });
    await assert.rejects(
      guardedFetch(policy, delegate.fetch)("https://api.openai.com/a", {
        method: "POST",
        body: new ReadableStream(),
        duplex: "half",
      } as RequestInit),
      TypeError,
    );
  });

  it("stops after twenty redirects", async () => {
    const delegate = scripted({
      "https://api.openai.com/loop": () => redirect(302, "/loop"),
    });
    await assert.rejects(
      guardedFetch(policy, delegate.fetch)("https://api.openai.com/loop"),
      TypeError,
    );
    assert.strictEqual(delegate.calls.length, 21);
  });

  it("checks a Request input by its URL", async () => {
    const delegate = scripted({});
    await assert.rejects(
      guardedFetch(policy, delegate.fetch)(
        new Request("https://evil.example.test/x"),
      ),
      EgressRefusedError,
    );
  });
});

describe("assertConnectAllowed", () => {
  it("allows the configured Dolt endpoint", () => {
    assertConnectAllowed(policy, "127.0.0.1", 3306);
  });

  it("refuses any other host or port, naming it and where to configure it", () => {
    assert.throws(
      () => assertConnectAllowed(policy, "db.example.test", 3306),
      (error: unknown) =>
        error instanceof EgressRefusedError &&
        /"db\.example\.test:3306"/.test(error.message) &&
        /DOLT_HOST/.test(error.message),
    );
    assert.throws(
      () => assertConnectAllowed(policy, "127.0.0.1", 3307),
      EgressRefusedError,
    );
  });

  it("refuses when the policy names no Dolt endpoint", () => {
    assert.throws(
      () => assertConnectAllowed(composeRuntimePolicy({}), "127.0.0.1", 3306),
      EgressRefusedError,
    );
  });
});
