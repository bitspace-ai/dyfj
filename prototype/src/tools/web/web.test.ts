import {
  captureRejection,
  captureThrow,
} from "../../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWebToolsSessionState,
  defineWebCommands,
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_FETCH_CALLS_PER_TURN,
  MAX_SEARCH_CALLS_PER_TURN,
  normalizeSearchResults,
  resetWebToolsTurnState,
} from "./web.ts";
import {
  assertPublicDnsResolution,
  assertPublicHttpsUrl,
  isPrivateOrLoopbackIp,
} from "./web-url-safety.ts";
import {
  decodeHtmlEntities,
  extractReadableContentFromHtml,
  safeFetchDocument,
} from "./web-document.ts";
import type { McpHttpServerConfig } from "../../config/mod.ts";
import { ScriptedDnsResolver } from "../../../testing/fakes/scripted-dns-resolver.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";

/** The thrown error's message must match `pattern`. */
function assertThrowsMatching(fn: () => unknown, pattern: RegExp): void {
  const err = captureThrow(fn);
  assert.ok(err instanceof Error, "expected an Error to be thrown");
  assert.match(err.message, pattern);
}

/** The rejection message must match `pattern`. */
async function assertRejectsMatching(
  fn: () => unknown,
  pattern: RegExp,
): Promise<void> {
  const err = await captureRejection(async () => {
    await fn();
  });
  assert.ok(err instanceof Error, "expected an Error rejection");
  assert.match(err.message, pattern);
}

/**
 * A `DnsResolver` fake that answers the hosts these tests fetch from with
 * public addresses, so the address check never reaches a real resolver.
 */
function publicDns(): ScriptedDnsResolver {
  const publicHost = {
    A: ["93.184.216.34"],
    AAAA: ["2606:4700:4700::1111"],
  };
  return new ScriptedDnsResolver({
    "example.com": publicHost,
    "docs.tavily.com": publicHost,
  });
}

describe("isPrivateOrLoopbackIp", () => {
  it("identifies loopback, private, link-local, CGNAT, benchmark, and documentation IPv4 addresses", () => {
    assert.strictEqual(isPrivateOrLoopbackIp("127.0.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("127.10.20.30"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("10.0.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("10.255.255.255"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("100.64.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("100.127.255.255"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("172.16.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("172.31.255.255"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("192.168.1.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("169.254.169.254"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("0.0.0.0"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("255.255.255.255"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("224.0.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("192.0.2.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("198.18.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("198.51.100.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("203.0.113.1"), true);
  });

  it("identifies IPv4-mapped IPv6 addresses targeting loopback or private ranges", () => {
    assert.strictEqual(isPrivateOrLoopbackIp("::ffff:127.0.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("::ffff:7f00:1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("[::ffff:7f00:1]"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("0:0:0:0:0:ffff:7f00:1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("::ffff:10.0.0.1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("::ffff:192.168.1.1"), true);
  });

  it("identifies loopback, link-local, unique-local, documentation, and multicast IPv6 addresses", () => {
    assert.strictEqual(isPrivateOrLoopbackIp("::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("::"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("fe80::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("fc00::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("fd12:3456::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("ff02::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("2001:db8::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("2001:2::1"), true);
    assert.strictEqual(isPrivateOrLoopbackIp("64:ff9b::1"), true);
  });

  it("allows public IP addresses and domain names with special prefixes", () => {
    assert.strictEqual(isPrivateOrLoopbackIp("8.8.8.8"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("1.1.1.1"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("93.184.216.34"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("172.15.0.1"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("172.32.0.1"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("2606:4700:4700::1111"), false);
    // Domain names starting with fd or ff must NOT be classified as private IPv6
    assert.strictEqual(isPrivateOrLoopbackIp("fda.gov"), false);
    assert.strictEqual(isPrivateOrLoopbackIp("ffmpeg.org"), false);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("accepts valid public HTTPS URLs including fda.gov and ffmpeg.org", () => {
    const url1 = assertPublicHttpsUrl("https://fda.gov/drugs");
    assert.strictEqual(url1.hostname, "fda.gov");
    assert.strictEqual(url1.protocol, "https:");

    const url2 = assertPublicHttpsUrl("https://ffmpeg.org/documentation.html");
    assert.strictEqual(url2.hostname, "ffmpeg.org");
  });

  it("rejects non-HTTPS protocols", () => {
    assertThrowsMatching(
      () => assertPublicHttpsUrl("http://example.com"),
      /HTTPS/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("ftp://example.com"),
      /HTTPS/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("file:///etc/passwd"),
      /HTTPS/,
    );
  });

  it("rejects embedded user credentials", () => {
    const credUrl = ["https://user", "pass@example.com"].join(":");
    assertThrowsMatching(() => assertPublicHttpsUrl(credUrl), /credentials/);
  });

  it("rejects localhost (with or without trailing dots), private IPs, and IPv4-mapped IPv6 literals", () => {
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://localhost/api"),
      /localhost/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://localhost./api"),
      /localhost/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://sub.localhost/"),
      /localhost/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://sub.localhost./"),
      /localhost/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://127.0.0.1:8080/"),
      /private/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://192.168.1.1/"),
      /private/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://10.0.0.5/"),
      /private/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/"),
      /private/,
    );
    assertThrowsMatching(
      () => assertPublicHttpsUrl("https://[::ffff:7f00:1]/"),
      /private/,
    );
  });

  it("allows loopback HTTP in testing mode when requested", () => {
    const url = assertPublicHttpsUrl("http://127.0.0.1:8787/test", true);
    assert.strictEqual(url.hostname, "127.0.0.1");
    assert.strictEqual(url.protocol, "http:");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    assert.strictEqual(
      decodeHtmlEntities(
        "&lt;div&gt;&amp;&quot;&#39;&nbsp;&copy;&reg;&trade;&ndash;&mdash;&hellip;&ldquo;&rdquo;&lsquo;&rsquo;&bull;&cent;&pound;&yen;&euro;&#65;&#x42;",
      ),
      "<div>&\"' ©®™–—…“”‘’•¢£¥€AB",
    );
  });
});

describe("extractReadableContentFromHtml", () => {
  it("strips scripts, styles, nav, and formats clean markdown", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <style>body { color: red; }</style>
          <script>alert("evil");</script>
        </head>
        <body>
          <nav><a href="/">Home</a> <a href="/about">About</a></nav>
          <header><h1>Site Header</h1></header>
          <main>
            <h1>Main Title</h1>
            <p>This is a paragraph with a <a href="https://example.com/link">link text</a>.</p>
            <h2>Subheading</h2>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
          </main>
          <footer>Footer text</footer>
        </body>
      </html>
    `;
    const markdown = extractReadableContentFromHtml(html);
    assert.ok(
      markdown.includes("# Main Title"),
      `expected ${JSON.stringify(markdown)} to include "# Main Title"`,
    );
    assert.ok(
      markdown.includes("[link text](https://example.com/link)"),
      `expected ${
        JSON.stringify(markdown)
      } to include "[link text](https://example.com/link)"`,
    );
    assert.ok(
      markdown.includes("## Subheading"),
      `expected ${JSON.stringify(markdown)} to include "## Subheading"`,
    );
    assert.ok(
      markdown.includes("- Item 1"),
      `expected ${JSON.stringify(markdown)} to include "- Item 1"`,
    );
    assert.ok(
      markdown.includes("- Item 2"),
      `expected ${JSON.stringify(markdown)} to include "- Item 2"`,
    );
    assert.ok(!markdown.includes("alert"));
    assert.ok(!markdown.includes("color: red"));
    assert.ok(!markdown.includes("Site Header"));
    assert.ok(!markdown.includes("Footer text"));
  });
});

describe("normalizeSearchResults", () => {
  it("normalizes Tavily-shaped search results", () => {
    const tavilyOutput = {
      results: [
        {
          title: "First Result",
          url: "https://example.com/1",
          content: "Snippet 1",
          published_date: "2026-08-01",
        },
        {
          title: "Second Result",
          url: "https://example.com/2",
          content: "Snippet 2",
        },
      ],
    };

    const items = normalizeSearchResults(tavilyOutput);
    assert.deepStrictEqual(items, [
      {
        id: "s1",
        title: "First Result",
        url: "https://example.com/1",
        snippet: "Snippet 1",
        rank: 1,
        publishedDate: "2026-08-01",
      },
      {
        id: "s2",
        title: "Second Result",
        url: "https://example.com/2",
        snippet: "Snippet 2",
        rank: 2,
      },
    ]);
  });

  it("normalizes generic array search results", () => {
    const genericArray = [
      {
        name: "Item Alpha",
        link: "https://alpha.org",
        description: "Alpha snippet",
      },
    ];
    const items = normalizeSearchResults(genericArray);
    assert.deepStrictEqual(items, [
      {
        id: "s1",
        title: "Item Alpha",
        url: "https://alpha.org",
        snippet: "Alpha snippet",
        rank: 1,
      },
    ]);
  });
});

describe("assertPublicDnsResolution", () => {
  it("accepts a host whose A and AAAA answers are public", async () => {
    const dns = publicDns();
    await assertPublicDnsResolution("example.com", false, undefined, dns);
    assert.deepStrictEqual(dns.lookups, [
      { hostname: "example.com", recordType: "A" },
      { hostname: "example.com", recordType: "AAAA" },
    ]);
  });

  it("rejects a host whose A answer includes a private address", async () => {
    const dns = new ScriptedDnsResolver({
      "internal.example": { A: ["93.184.216.34", "10.0.0.5"] },
    });
    await assertRejectsMatching(
      () =>
        assertPublicDnsResolution("internal.example", false, undefined, dns),
      /resolves to private or internal IP address 10\.0\.0\.5/,
    );
  });

  it("rejects a host whose AAAA answer is loopback", async () => {
    const dns = new ScriptedDnsResolver({
      "v6.example": { A: ["93.184.216.34"], AAAA: ["::1"] },
    });
    await assertRejectsMatching(
      () => assertPublicDnsResolution("v6.example", false, undefined, dns),
      /resolves to private or internal IP address ::1/,
    );
  });

  it("accepts a host with only an A answer", async () => {
    const dns = new ScriptedDnsResolver({
      "v4only.example": { A: ["93.184.216.34"] },
    });
    await assertPublicDnsResolution("v4only.example", false, undefined, dns);
  });

  it("rejects a host whose lookup cannot be made", async () => {
    const dns = new ScriptedDnsResolver({}, { unavailable: true });
    await assertRejectsMatching(
      () => assertPublicDnsResolution("example.com", false, undefined, dns),
      /could not be verified: DNS lookup unavailable/,
    );
  });

  it("rejects a host whose lookup fails", async () => {
    const dns = new ScriptedDnsResolver({ "down.example": "failed" });
    await assertRejectsMatching(
      () => assertPublicDnsResolution("down.example", false, undefined, dns),
      /could not be verified: DNS lookup failed/,
    );
  });

  it("rejects a host that resolves to no address", async () => {
    const dns = new ScriptedDnsResolver();
    await assertRejectsMatching(
      () => assertPublicDnsResolution("nothing.example", false, undefined, dns),
      /does not resolve to any address/,
    );
  });

  it("rejects when the resolver itself throws", async () => {
    const throwing = {
      resolve: () => Promise.reject(new Error("resolver exploded")),
    };
    await assertRejectsMatching(
      () =>
        assertPublicDnsResolution("example.com", false, undefined, throwing),
      /^Target host 'example\.com' could not be verified: DNS lookup failed$/,
    );
  });

  it("rejects an already-expired deadline without a lookup", async () => {
    const dns = publicDns();
    await assertRejectsMatching(
      () =>
        assertPublicDnsResolution(
          "example.com",
          false,
          AbortSignal.abort(),
          dns,
        ),
      /DNS lookup timed out/,
    );
    assert.deepStrictEqual(dns.lookups, []);
  });

  it("rejects a lookup that outlives the deadline", async () => {
    const controller = new AbortController();
    const hanging = {
      resolve: () => {
        controller.abort();
        return new Promise<never>(() => {});
      },
    };
    await assertRejectsMatching(
      () =>
        assertPublicDnsResolution(
          "example.com",
          false,
          controller.signal,
          hanging,
        ),
      /DNS lookup timed out/,
    );
  });

  it("accepts public IP literals without a lookup", async () => {
    const dns = new ScriptedDnsResolver({}, { unavailable: true });
    await assertPublicDnsResolution("93.184.216.34", false, undefined, dns);
    await assertPublicDnsResolution(
      "[2606:4700:4700::1111]",
      false,
      undefined,
      dns,
    );
    assert.deepStrictEqual(dns.lookups, []);
  });

  it("rejects a private IP literal before any lookup", async () => {
    const dns = publicDns();
    await assertRejectsMatching(
      () => assertPublicDnsResolution("192.168.1.1", false, undefined, dns),
      /enumerated private or internal IP address/,
    );
    assert.deepStrictEqual(dns.lookups, []);
  });
});

describe("safeFetchDocument", () => {
  it("fetches and extracts clean markdown from an HTML response", async () => {
    const dns = publicDns();
    const transport = new ScriptedHttpTransport([{
      respond: {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: "<h1>Hello World</h1><p>Test body</p>",
      },
    }]);

    const doc = await safeFetchDocument(
      "https://example.com/page",
      transport.fetchLike,
      false,
      dns,
    );
    assert.deepStrictEqual(dns.lookups, [
      { hostname: "example.com", recordType: "A" },
      { hostname: "example.com", recordType: "AAAA" },
    ]);
    assert.strictEqual(doc.url, "https://example.com/page");
    assert.strictEqual(doc.contentType, "text/html");
    assert.ok(
      doc.text.includes("# Hello World"),
      `expected doc.text to include "# Hello World"`,
    );
    assert.ok(
      doc.text.includes("Test body"),
      `expected doc.text to include "Test body"`,
    );
  });

  it("rejects unsupported content types and cancels response stream", async () => {
    const dns = publicDns();
    let bodyCancelled = false;
    const fakeStream = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    });
    // A function responder: the test observes the body being cancelled.
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        new Response(fakeStream, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    }]);

    await assertRejectsMatching(
      () =>
        safeFetchDocument(
          "https://example.com/pic.png",
          transport.fetchLike,
          false,
          dns,
        ),
      /Unsupported content type/,
    );
    assert.strictEqual(bodyCancelled, true);
    assert.deepStrictEqual(dns.lookups.length, 2);
  });

  it("truncates content exceeding character limit", async () => {
    const dns = publicDns();
    const hugeText = "<p>" +
      "A".repeat(MAX_EXTRACTED_CHARS_PER_FETCH + 5000) + "</p>";
    const transport = new ScriptedHttpTransport([{
      respond: { headers: { "Content-Type": "text/html" }, body: hugeText },
    }]);

    const doc = await safeFetchDocument(
      "https://example.com/huge",
      transport.fetchLike,
      false,
      dns,
    );
    assert.deepStrictEqual(dns.lookups.length, 2);
    assert.strictEqual(
      doc.text.endsWith("[Content truncated at 40,000 characters]"),
      true,
    );
    assert.strictEqual(doc.text.length, MAX_EXTRACTED_CHARS_PER_FETCH);
  });
});

describe("defineWebCommands", () => {
  const server: McpHttpServerConfig = {
    id: "tavily",
    transport: "streamable_http",
    url: "https://mcp.tavily.com/mcp",
    minimumClearance: "loopback",
    auth: { type: "bearer", secret: "tavily_key" },
    tools: [
      { name: "tavily_search", effect: "read", approval: "allow" },
      { name: "tavily_extract", effect: "read", approval: "allow" },
    ],
    capabilities: {
      searchTool: "tavily_search",
      fetchTool: "tavily_extract",
    },
  };

  it("inherits configured tool effects and approval decisions", () => {
    const customServer: McpHttpServerConfig = {
      ...server,
      tools: [
        {
          name: "tavily_search",
          effect: "write_external",
          approval: "ask",
        },
        { name: "tavily_extract", effect: "read", approval: "allow" },
      ],
    };
    const commands = defineWebCommands(customServer, "token");
    const searchCmd = commands.find((c) => c.id === "web_search")!;
    const { effects } = searchCmd.permission;
    assert.deepStrictEqual(
      (["write.external"] as const).filter((item) => !effects.includes(item)),
      [],
    );
    assert.strictEqual(searchCmd.permission.defaultDecision, "ask");
  });

  it("registers web_search and web_fetch commands with untrusted result framing and clamps result limits", async () => {
    const dns = publicDns();
    const state = createWebToolsSessionState();
    const fakeCall = () =>
      Promise.resolve({
        content: [{
          type: "text",
          text: JSON.stringify({
            results: [
              {
                title: "Tavily Doc 1",
                url: "https://docs.tavily.com/1",
                content: "Official Tavily Documentation 1",
              },
              {
                title: "Tavily Doc 2",
                url: "https://docs.tavily.com/2",
                content: "Official Tavily Documentation 2",
              },
            ],
          }),
        }],
      });

    const commands = defineWebCommands(
      server,
      "test_token",
      { call: fakeCall },
      state,
      true,
      {},
      dns,
    );

    assert.deepStrictEqual(commands.map((c) => c.id), [
      "web_search",
      "web_fetch",
    ]);

    const searchCmd = commands.find((c) => c.id === "web_search")!;
    // Request limit = 1: verify only 1 result is returned
    const searchRes = await searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "tavily docs", limit: 1 },
    }, { authzBasis: "test" });

    assert.ok(
      searchRes.includes("<untrusted-mcp-result>"),
      `expected ${
        JSON.stringify(searchRes)
      } to include "<untrusted-mcp-result>"`,
    );
    assert.ok(
      searchRes.includes("Tavily Doc 1"),
      `expected ${JSON.stringify(searchRes)} to include "Tavily Doc 1"`,
    );
    assert.ok(!searchRes.includes("Tavily Doc 2"));
    assert.ok(
      searchRes.includes("ID: s1"),
      `expected ${JSON.stringify(searchRes)} to include "ID: s1"`,
    );
    assert.strictEqual(
      state.getTurnState().sourceUrlMap.get("s1"),
      "https://docs.tavily.com/1",
    );
    assert.strictEqual(state.getTurnState().sourceUrlMap.has("s2"), false);

    // Test follow-up web_fetch with upstream fetchTool delegation
    let fetchToolCalled = false;
    const fakeFetchCall = () => {
      fetchToolCalled = true;
      return Promise.resolve({
        content: [{
          type: "text",
          text: "# Tavily Extract Content\nDetails from upstream extract tool",
        }],
      });
    };

    const fetchCommands = defineWebCommands(
      server,
      "test_token",
      { call: fakeFetchCall },
      state,
      true,
      {},
      dns,
    );
    const delegatedFetchCmd = fetchCommands.find((c) => c.id === "web_fetch")!;

    const fetchRes = await delegatedFetchCmd.executor({
      callId: "call_2",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { sourceId: "s1" },
    }, { authzBasis: "test" });

    assert.strictEqual(fetchToolCalled, true);
    assert.deepStrictEqual(dns.lookups, [
      { hostname: "docs.tavily.com", recordType: "A" },
      { hostname: "docs.tavily.com", recordType: "AAAA" },
    ]);
    assert.ok(
      fetchRes.includes("<untrusted-mcp-result>"),
      `expected ${
        JSON.stringify(fetchRes)
      } to include "<untrusted-mcp-result>"`,
    );
    assert.ok(
      fetchRes.includes("# Tavily Extract Content"),
      `expected ${
        JSON.stringify(fetchRes)
      } to include "# Tavily Extract Content"`,
    );

    // Delegated fetch on private URL must still be rejected
    await assertRejectsMatching(() =>
      delegatedFetchCmd.executor({
        callId: "call_3",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { url: "https://192.168.1.1/admin" },
      }, { authzBasis: "test" }), /forbidden|private/);
    // Rejected on the IP literal, before any DNS lookup.
    assert.deepStrictEqual(dns.lookups.length, 2);
  });

  it("refuses a web_fetch target it cannot verify without calling upstream", async () => {
    let upstreamCalled = false;
    const commands = defineWebCommands(
      server,
      "test_token",
      {
        call: () => {
          upstreamCalled = true;
          return Promise.resolve({ content: [] });
        },
      },
      createWebToolsSessionState(),
      false,
      {},
      new ScriptedDnsResolver({}, { unavailable: true }),
    );
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;

    await assertRejectsMatching(() =>
      fetchCmd.executor({
        callId: "call_unverified",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { url: "https://example.com/page" },
      }, { authzBasis: "test" }), /could not be verified/);
    assert.strictEqual(upstreamCalled, false);
  });

  it("empty search result clears prior source map", async () => {
    const state = createWebToolsSessionState();
    state.getTurnState().sourceUrlMap.set("s1", "https://stale.com");

    const fakeEmptyCall = () =>
      Promise.resolve({
        content: [{
          type: "text",
          text: JSON.stringify({ results: [] }),
        }],
      });

    const commands = defineWebCommands(
      server,
      "test_token",
      { call: fakeEmptyCall },
      state,
      true,
    );
    const searchCmd = commands.find((c) => c.id === "web_search")!;

    await searchCmd.executor({
      callId: "call_empty",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "empty query" },
    }, { authzBasis: "test" });

    assert.strictEqual(state.getTurnState().sourceUrlMap.size, 0);
  });

  it("resets turn state and enforces max search and fetch calls per turn", async () => {
    const state = createWebToolsSessionState();
    state.getTurnState().searchCount = MAX_SEARCH_CALLS_PER_TURN;
    const commands = defineWebCommands(server, "test_token", {}, state, true);
    const searchCmd = commands.find((c) => c.id === "web_search")!;

    // Max search calls exceeded
    await assertRejectsMatching(() =>
      searchCmd.executor({
        callId: "call_1",
        commandId: "web_search",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { query: "overflow" },
      }, { authzBasis: "test" }), /Web search call limit exceeded/);

    // Reset turn state
    resetWebToolsTurnState(state);
    assert.strictEqual(state.getTurnState().searchCount, 0);
    assert.strictEqual(state.getTurnState().fetchCount, 0);

    // Max fetch calls exceeded
    state.getTurnState().fetchCount = MAX_FETCH_CALLS_PER_TURN;
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;
    await assertRejectsMatching(() =>
      fetchCmd.executor({
        callId: "call_fetch_over",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { url: "https://example.com/item" },
      }, { authzBasis: "test" }), /Web fetch call limit exceeded/);
  });

  it("automatically resets turn state when traceId changes between turns", async () => {
    const state = createWebToolsSessionState();
    const fakeCall = () =>
      Promise.resolve({
        content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
      });
    const commands = defineWebCommands(
      server,
      "test_token",
      { call: fakeCall },
      state,
      true,
    );
    const searchCmd = commands.find((c) => c.id === "web_search")!;

    // Run 3 searches under turn-1
    for (let i = 1; i <= 3; i++) {
      await searchCmd.executor({
        callId: `call_${i}`,
        commandId: "web_search",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { query: `query ${i}` },
      }, { authzBasis: "test", traceId: "turn-1" });
    }

    // 4th search in turn-1 fails
    await assertRejectsMatching(
      () =>
        searchCmd.executor({
          callId: "call_4",
          commandId: "web_search",
          caller: { principalId: "operator", principalType: "human" },
          arguments: { query: "query 4" },
        }, { authzBasis: "test", traceId: "turn-1" }),
      /Web search call limit exceeded/,
    );

    // 1st search in turn-2 automatically resets and succeeds
    const res = await searchCmd.executor({
      callId: "call_5",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "query 5" },
    }, { authzBasis: "test", traceId: "turn-2" });

    assert.ok(
      res.includes("<untrusted-mcp-result>"),
      `expected ${JSON.stringify(res)} to include "<untrusted-mcp-result>"`,
    );
    assert.strictEqual(state.getTurnState("turn-2").searchCount, 1);
  });

  it("rejects ambiguous web_fetch calls with both url and sourceId", async () => {
    const commands = defineWebCommands(
      server,
      "test_token",
      {},
      createWebToolsSessionState(),
      true,
    );
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;

    await assertRejectsMatching(() =>
      fetchCmd.executor({
        callId: "call_ambiguous",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { url: "https://example.com/page", sourceId: "s1" },
      }, { authzBasis: "test" }), /either 'url' or 'sourceId'/);
  });

  it("bounds turn state cardinality at MAX_SESSION_TURNS_CAP", () => {
    const state = createWebToolsSessionState();
    for (let i = 0; i < 110; i++) {
      state.getTurnState(`trace_${i}`);
    }
    assert.ok(state.turns.size <= 100, `expected state.turns.size <= 100`);
  });
});
