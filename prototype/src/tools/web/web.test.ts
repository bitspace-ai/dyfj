import { describe, it } from "@std/testing/bdd";
import {
  assertSpyCallArgs,
  assertSpyCalls,
  type Stub,
  stub,
} from "@std/testing/mock";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertLessOrEqual,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertPublicHttpsUrl,
  createWebToolsSessionState,
  decodeHtmlEntities,
  defineWebCommands,
  extractReadableContentFromHtml,
  isPrivateOrLoopbackIp,
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_FETCH_CALLS_PER_TURN,
  MAX_SEARCH_CALLS_PER_TURN,
  normalizeSearchResults,
  resetWebToolsTurnState,
  safeFetchDocument,
} from "./web.ts";
import type { McpHttpServerConfig } from "../../config/mod.ts";

type ResolveDnsAorAAAA = (
  host: string,
  recordType: "A" | "AAAA",
) => Promise<string[]>;

/** Vitest `toThrow(regex)` equivalent: the thrown error's message must match. */
function assertThrowsMatching(fn: () => unknown, pattern: RegExp): void {
  const err = assertThrows(fn);
  assert(err instanceof Error, "expected an Error to be thrown");
  assertMatch(err.message, pattern);
}

/** Vitest `rejects.toThrow(regex)` equivalent: the rejection message must match. */
async function assertRejectsMatching(
  fn: () => unknown,
  pattern: RegExp,
): Promise<void> {
  const err = await assertRejects(async () => {
    await fn();
  });
  assert(err instanceof Error, "expected an Error rejection");
  assertMatch(err.message, pattern);
}

/**
 * Replace the global `Deno.resolveDns` with a fake that answers every A/AAAA
 * lookup with a public address, so the DNS preflight in
 * web.ts never reaches a real resolver. Dispose (via `using`) to restore.
 */
function stubPublicDns(): Stub {
  const fake: ResolveDnsAorAAAA = (_host, recordType) =>
    Promise.resolve(
      recordType === "A" ? ["93.184.216.34"] : ["2606:4700:4700::1111"],
    );
  return stub(
    Deno as unknown as { resolveDns: ResolveDnsAorAAAA },
    "resolveDns",
    fake,
  );
}

describe("isPrivateOrLoopbackIp", () => {
  it("identifies loopback, private, link-local, CGNAT, benchmark, and documentation IPv4 addresses", () => {
    assertStrictEquals(isPrivateOrLoopbackIp("127.0.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("127.10.20.30"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("10.0.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("10.255.255.255"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("100.64.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("100.127.255.255"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("172.16.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("172.31.255.255"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("192.168.1.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("169.254.169.254"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("0.0.0.0"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("255.255.255.255"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("224.0.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("192.0.2.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("198.18.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("198.51.100.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("203.0.113.1"), true);
  });

  it("identifies IPv4-mapped IPv6 addresses targeting loopback or private ranges", () => {
    assertStrictEquals(isPrivateOrLoopbackIp("::ffff:127.0.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("::ffff:7f00:1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("[::ffff:7f00:1]"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("0:0:0:0:0:ffff:7f00:1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("::ffff:10.0.0.1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("::ffff:192.168.1.1"), true);
  });

  it("identifies loopback, link-local, unique-local, documentation, and multicast IPv6 addresses", () => {
    assertStrictEquals(isPrivateOrLoopbackIp("::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("::"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("fe80::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("fc00::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("fd12:3456::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("ff02::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("2001:db8::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("2001:2::1"), true);
    assertStrictEquals(isPrivateOrLoopbackIp("64:ff9b::1"), true);
  });

  it("allows public IP addresses and domain names with special prefixes", () => {
    assertStrictEquals(isPrivateOrLoopbackIp("8.8.8.8"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("1.1.1.1"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("93.184.216.34"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("172.15.0.1"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("172.32.0.1"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("2606:4700:4700::1111"), false);
    // Domain names starting with fd or ff must NOT be classified as private IPv6
    assertStrictEquals(isPrivateOrLoopbackIp("fda.gov"), false);
    assertStrictEquals(isPrivateOrLoopbackIp("ffmpeg.org"), false);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("accepts valid public HTTPS URLs including fda.gov and ffmpeg.org", () => {
    const url1 = assertPublicHttpsUrl("https://fda.gov/drugs");
    assertStrictEquals(url1.hostname, "fda.gov");
    assertStrictEquals(url1.protocol, "https:");

    const url2 = assertPublicHttpsUrl("https://ffmpeg.org/documentation.html");
    assertStrictEquals(url2.hostname, "ffmpeg.org");
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
    assertStrictEquals(url.hostname, "127.0.0.1");
    assertStrictEquals(url.protocol, "http:");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    assertStrictEquals(
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
    assertStringIncludes(markdown, "# Main Title");
    assertStringIncludes(markdown, "[link text](https://example.com/link)");
    assertStringIncludes(markdown, "## Subheading");
    assertStringIncludes(markdown, "- Item 1");
    assertStringIncludes(markdown, "- Item 2");
    assertFalse(markdown.includes("alert"));
    assertFalse(markdown.includes("color: red"));
    assertFalse(markdown.includes("Site Header"));
    assertFalse(markdown.includes("Footer text"));
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
    assertEquals(items, [
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
    assertEquals(items, [
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

describe("safeFetchDocument", () => {
  it("fetches and extracts clean markdown from an HTML response", async () => {
    using dns = stubPublicDns();
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response("<h1>Hello World</h1><p>Test body</p>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );

    const doc = await safeFetchDocument("https://example.com/page", fakeFetch);
    assertSpyCalls(dns, 2);
    assertSpyCallArgs(dns, 0, ["example.com", "A"]);
    assertSpyCallArgs(dns, 1, ["example.com", "AAAA"]);
    assertStrictEquals(doc.url, "https://example.com/page");
    assertStrictEquals(doc.contentType, "text/html");
    assertStringIncludes(doc.text, "# Hello World");
    assertStringIncludes(doc.text, "Test body");
  });

  it("rejects unsupported content types and cancels response stream", async () => {
    using dns = stubPublicDns();
    let bodyCancelled = false;
    const fakeStream = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    });
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(fakeStream, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

    await assertRejectsMatching(
      () => safeFetchDocument("https://example.com/pic.png", fakeFetch),
      /Unsupported content type/,
    );
    assertStrictEquals(bodyCancelled, true);
    assertSpyCalls(dns, 2);
  });

  it("truncates content exceeding character limit", async () => {
    using dns = stubPublicDns();
    const hugeText = "<p>" +
      "A".repeat(MAX_EXTRACTED_CHARS_PER_FETCH + 5000) + "</p>";
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(hugeText, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    const doc = await safeFetchDocument("https://example.com/huge", fakeFetch);
    assertSpyCalls(dns, 2);
    assertStrictEquals(
      doc.text.endsWith("[Content truncated at 40,000 characters]"),
      true,
    );
    assertStrictEquals(doc.text.length, MAX_EXTRACTED_CHARS_PER_FETCH);
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
    assertArrayIncludes(searchCmd.permission.effects, ["write.external"]);
    assertStrictEquals(searchCmd.permission.defaultDecision, "ask");
  });

  it("registers web_search and web_fetch commands with untrusted result framing and clamps result limits", async () => {
    using dns = stubPublicDns();
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
    );

    assertEquals(commands.map((c) => c.id), ["web_search", "web_fetch"]);

    const searchCmd = commands.find((c) => c.id === "web_search")!;
    // Request limit = 1: verify only 1 result is returned
    const searchRes = await searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "tavily docs", limit: 1 },
    }, { authzBasis: "test" });

    assertStringIncludes(searchRes, "<untrusted-mcp-result>");
    assertStringIncludes(searchRes, "Tavily Doc 1");
    assertFalse(searchRes.includes("Tavily Doc 2"));
    assertStringIncludes(searchRes, "ID: s1");
    assertStrictEquals(
      state.getTurnState().sourceUrlMap.get("s1"),
      "https://docs.tavily.com/1",
    );
    assertStrictEquals(state.getTurnState().sourceUrlMap.has("s2"), false);

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
    );
    const delegatedFetchCmd = fetchCommands.find((c) => c.id === "web_fetch")!;

    const fetchRes = await delegatedFetchCmd.executor({
      callId: "call_2",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { sourceId: "s1" },
    }, { authzBasis: "test" });

    assertStrictEquals(fetchToolCalled, true);
    assertSpyCalls(dns, 2);
    assertSpyCallArgs(dns, 0, ["docs.tavily.com", "A"]);
    assertSpyCallArgs(dns, 1, ["docs.tavily.com", "AAAA"]);
    assertStringIncludes(fetchRes, "<untrusted-mcp-result>");
    assertStringIncludes(fetchRes, "# Tavily Extract Content");

    // Delegated fetch on private URL must still be rejected
    await assertRejectsMatching(() =>
      delegatedFetchCmd.executor({
        callId: "call_3",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { url: "https://192.168.1.1/admin" },
      }, { authzBasis: "test" }), /forbidden|private/);
    // Rejected on the IP literal, before any DNS lookup.
    assertSpyCalls(dns, 2);
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

    assertStrictEquals(state.getTurnState().sourceUrlMap.size, 0);
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
    assertStrictEquals(state.getTurnState().searchCount, 0);
    assertStrictEquals(state.getTurnState().fetchCount, 0);

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

    assertStringIncludes(res, "<untrusted-mcp-result>");
    assertStrictEquals(state.getTurnState("turn-2").searchCount, 1);
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
    assertLessOrEqual(state.turns.size, 100);
  });
});
