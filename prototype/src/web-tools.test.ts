import { describe, expect, test } from "vitest";
import {
  assertPublicHttpsUrl,
  buildWebCommands,
  createWebToolsSessionState,
  decodeHtmlEntities,
  extractReadableContentFromHtml,
  isPrivateOrLoopbackIp,
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_FETCH_CALLS_PER_TURN,
  MAX_SEARCH_CALLS_PER_TURN,
  normalizeSearchResults,
  resetWebToolsTurnState,
  safeFetchDocument,
} from "./web-tools.ts";
import type { McpHttpServerConfig } from "./config.ts";

describe("isPrivateOrLoopbackIp", () => {
  test("identifies loopback, private, link-local, CGNAT, benchmark, and documentation IPv4 addresses", () => {
    expect(isPrivateOrLoopbackIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("127.10.20.30")).toBe(true);
    expect(isPrivateOrLoopbackIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("100.127.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopbackIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopbackIp("255.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("224.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("192.0.2.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("198.18.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("198.51.100.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("203.0.113.1")).toBe(true);
  });

  test("identifies IPv4-mapped IPv6 addresses targeting loopback or private ranges", () => {
    expect(isPrivateOrLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrLoopbackIp("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateOrLoopbackIp("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:192.168.1.1")).toBe(true);
  });

  test("identifies loopback, link-local, unique-local, documentation, and multicast IPv6 addresses", () => {
    expect(isPrivateOrLoopbackIp("::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::")).toBe(true);
    expect(isPrivateOrLoopbackIp("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("fd12:3456::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("ff02::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("2001:db8::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("2001:2::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("64:ff9b::1")).toBe(true);
  });

  test("allows public IP addresses and domain names with special prefixes", () => {
    expect(isPrivateOrLoopbackIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.32.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("2606:4700:4700::1111")).toBe(false);
    // Domain names starting with fd or ff must NOT be classified as private IPv6
    expect(isPrivateOrLoopbackIp("fda.gov")).toBe(false);
    expect(isPrivateOrLoopbackIp("ffmpeg.org")).toBe(false);
  });
});

describe("assertPublicHttpsUrl", () => {
  test("accepts valid public HTTPS URLs including fda.gov and ffmpeg.org", () => {
    const url1 = assertPublicHttpsUrl("https://fda.gov/drugs");
    expect(url1.hostname).toBe("fda.gov");
    expect(url1.protocol).toBe("https:");

    const url2 = assertPublicHttpsUrl("https://ffmpeg.org/documentation.html");
    expect(url2.hostname).toBe("ffmpeg.org");
  });

  test("rejects non-HTTPS protocols", () => {
    expect(() => assertPublicHttpsUrl("http://example.com")).toThrow(/HTTPS/);
    expect(() => assertPublicHttpsUrl("ftp://example.com")).toThrow(/HTTPS/);
    expect(() => assertPublicHttpsUrl("file:///etc/passwd")).toThrow(/HTTPS/);
  });

  test("rejects embedded user credentials", () => {
    const credUrl = ["https://user", "pass@example.com"].join(":");
    expect(() => assertPublicHttpsUrl(credUrl)).toThrow(
      /credentials/,
    );
  });

  test("rejects localhost (with or without trailing dots), private IPs, and IPv4-mapped IPv6 literals", () => {
    expect(() => assertPublicHttpsUrl("https://localhost/api")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://localhost./api")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://sub.localhost/")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://sub.localhost./")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://127.0.0.1:8080/")).toThrow(
      /private/,
    );
    expect(() => assertPublicHttpsUrl("https://192.168.1.1/")).toThrow(
      /private/,
    );
    expect(() => assertPublicHttpsUrl("https://10.0.0.5/")).toThrow(/private/);
    expect(() =>
      assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/")
    )
      .toThrow(/private/);
    expect(() => assertPublicHttpsUrl("https://[::ffff:7f00:1]/")).toThrow(
      /private/,
    );
  });

  test("allows loopback HTTP in testing mode when requested", () => {
    const url = assertPublicHttpsUrl("http://127.0.0.1:8787/test", true);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.protocol).toBe("http:");
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes named and numeric entities", () => {
    expect(
      decodeHtmlEntities(
        "&lt;div&gt;&amp;&quot;&#39;&nbsp;&copy;&reg;&trade;&ndash;&mdash;&hellip;&ldquo;&rdquo;&lsquo;&rsquo;&bull;&cent;&pound;&yen;&euro;&#65;&#x42;",
      ),
    ).toBe(
      '<div>&"\' ©®™–—…“”‘’•¢£¥€AB',
    );
  });
});

describe("extractReadableContentFromHtml", () => {
  test("strips scripts, styles, nav, and formats clean markdown", () => {
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
    expect(markdown).toContain("# Main Title");
    expect(markdown).toContain("[link text](https://example.com/link)");
    expect(markdown).toContain("## Subheading");
    expect(markdown).toContain("- Item 1");
    expect(markdown).toContain("- Item 2");
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("color: red");
    expect(markdown).not.toContain("Site Header");
    expect(markdown).not.toContain("Footer text");
  });
});

describe("normalizeSearchResults", () => {
  test("normalizes Tavily-shaped search results", () => {
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
    expect(items).toEqual([
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

  test("normalizes generic array search results", () => {
    const genericArray = [
      {
        name: "Item Alpha",
        link: "https://alpha.org",
        description: "Alpha snippet",
      },
    ];
    const items = normalizeSearchResults(genericArray);
    expect(items).toEqual([
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
  test("fetches and extracts clean markdown from an HTML response", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response("<h1>Hello World</h1><p>Test body</p>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );

    const doc = await safeFetchDocument("https://example.com/page", fakeFetch);
    expect(doc.url).toBe("https://example.com/page");
    expect(doc.contentType).toBe("text/html");
    expect(doc.text).toContain("# Hello World");
    expect(doc.text).toContain("Test body");
  });

  test("rejects unsupported content types and cancels response stream", async () => {
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

    await expect(safeFetchDocument("https://example.com/pic.png", fakeFetch))
      .rejects.toThrow(/Unsupported content type/);
    expect(bodyCancelled).toBe(true);
  });

  test("truncates content exceeding character limit", async () => {
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
    expect(doc.text.endsWith("[Content truncated at 40,000 characters]")).toBe(
      true,
    );
    expect(doc.text.length).toBe(MAX_EXTRACTED_CHARS_PER_FETCH);
  });
});

describe("buildWebCommands", () => {
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

  test("inherits configured tool effects and approval decisions", () => {
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
    const commands = buildWebCommands(customServer, "token");
    const searchCmd = commands.find((c) => c.id === "web_search")!;
    expect(searchCmd.permission.effects).toContain("write.external");
    expect(searchCmd.permission.defaultDecision).toBe("ask");
  });

  test("registers web_search and web_fetch commands with untrusted result framing and clamps result limits", async () => {
    const state = createWebToolsSessionState();
    const fakeCall = async () => ({
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

    const commands = buildWebCommands(
      server,
      "test_token",
      { call: fakeCall },
      state,
      true,
    );

    expect(commands.map((c) => c.id)).toEqual(["web_search", "web_fetch"]);

    const searchCmd = commands.find((c) => c.id === "web_search")!;
    // Request limit = 1: verify only 1 result is returned
    const searchRes = await searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "tavily docs", limit: 1 },
    }, { authzBasis: "test" });

    expect(searchRes).toContain("<untrusted-mcp-result>");
    expect(searchRes).toContain("Tavily Doc 1");
    expect(searchRes).not.toContain("Tavily Doc 2");
    expect(searchRes).toContain("ID: s1");
    expect(state.getTurnState().sourceUrlMap.get("s1")).toBe(
      "https://docs.tavily.com/1",
    );
    expect(state.getTurnState().sourceUrlMap.has("s2")).toBe(false);

    // Test follow-up web_fetch with upstream fetchTool delegation
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;
    let fetchToolCalled = false;
    const fakeFetchCall = async () => {
      fetchToolCalled = true;
      return {
        content: [{
          type: "text",
          text: "# Tavily Extract Content\nDetails from upstream extract tool",
        }],
      };
    };

    const fetchCommands = buildWebCommands(
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

    expect(fetchToolCalled).toBe(true);
    expect(fetchRes).toContain("<untrusted-mcp-result>");
    expect(fetchRes).toContain("# Tavily Extract Content");

    // Delegated fetch on private URL must still be rejected
    await expect(delegatedFetchCmd.executor({
      callId: "call_3",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { url: "https://192.168.1.1/admin" },
    }, { authzBasis: "test" })).rejects.toThrow(/forbidden|private/);
  });

  test("empty search result clears prior source map", async () => {
    const state = createWebToolsSessionState();
    state.getTurnState().sourceUrlMap.set("s1", "https://stale.com");

    const fakeEmptyCall = async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ results: [] }),
      }],
    });

    const commands = buildWebCommands(
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

    expect(state.getTurnState().sourceUrlMap.size).toBe(0);
  });

  test("resets turn state and enforces max search and fetch calls per turn", async () => {
    const state = createWebToolsSessionState();
    state.getTurnState().searchCount = MAX_SEARCH_CALLS_PER_TURN;
    const commands = buildWebCommands(server, "test_token", {}, state, true);
    const searchCmd = commands.find((c) => c.id === "web_search")!;

    // Max search calls exceeded
    await expect(searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "overflow" },
    }, { authzBasis: "test" })).rejects.toThrow(/Web search call limit exceeded/);

    // Reset turn state
    resetWebToolsTurnState(state);
    expect(state.getTurnState().searchCount).toBe(0);
    expect(state.getTurnState().fetchCount).toBe(0);

    // Max fetch calls exceeded
    state.getTurnState().fetchCount = MAX_FETCH_CALLS_PER_TURN;
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;
    await expect(fetchCmd.executor({
      callId: "call_fetch_over",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { url: "https://example.com/item" },
    }, { authzBasis: "test" })).rejects.toThrow(/Web fetch call limit exceeded/);
  });

  test("automatically resets turn state when traceId changes between turns", async () => {
    const state = createWebToolsSessionState();
    const fakeCall = async () => ({
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
    });
    const commands = buildWebCommands(
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
    await expect(searchCmd.executor({
      callId: "call_4",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "query 4" },
    }, { authzBasis: "test", traceId: "turn-1" })).rejects.toThrow(
      /Web search call limit exceeded/,
    );

    // 1st search in turn-2 automatically resets and succeeds
    const res = await searchCmd.executor({
      callId: "call_5",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "query 5" },
    }, { authzBasis: "test", traceId: "turn-2" });

    expect(res).toContain("<untrusted-mcp-result>");
    expect(state.getTurnState("turn-2").searchCount).toBe(1);
  });

  test("rejects ambiguous web_fetch calls with both url and sourceId", async () => {
    const commands = buildWebCommands(server, "test_token", {}, createWebToolsSessionState(), true);
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;

    await expect(fetchCmd.executor({
      callId: "call_ambiguous",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { url: "https://example.com/page", sourceId: "s1" },
    }, { authzBasis: "test" })).rejects.toThrow(/either 'url' or 'sourceId'/);
  });

  test("bounds turn state cardinality at MAX_SESSION_TURNS_CAP", () => {
    const state = createWebToolsSessionState();
    for (let i = 0; i < 110; i++) {
      state.getTurnState(`trace_${i}`);
    }
    expect(state.turns.size).toBeLessThanOrEqual(100);
  });
});
