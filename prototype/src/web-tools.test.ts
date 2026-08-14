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
  safeFetchDocument,
} from "./web-tools.ts";
import type { McpHttpServerConfig } from "./config.ts";

describe("isPrivateOrLoopbackIp", () => {
  test("identifies loopback, private, link-local, and broadcast IPv4 addresses", () => {
    expect(isPrivateOrLoopbackIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("127.10.20.30")).toBe(true);
    expect(isPrivateOrLoopbackIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopbackIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopbackIp("255.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIp("224.0.0.1")).toBe(true);
  });

  test("identifies loopback, link-local, and unique-local IPv6 addresses", () => {
    expect(isPrivateOrLoopbackIp("::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::")).toBe(true);
    expect(isPrivateOrLoopbackIp("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("fd12:3456::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("ff02::1")).toBe(true);
  });

  test("allows public IP addresses", () => {
    expect(isPrivateOrLoopbackIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.32.0.1")).toBe(false);
  });
});

describe("assertPublicHttpsUrl", () => {
  test("accepts valid public HTTPS URLs", () => {
    const url = assertPublicHttpsUrl("https://example.com/docs/api?q=test#heading");
    expect(url.hostname).toBe("example.com");
    expect(url.protocol).toBe("https:");
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

  test("rejects localhost and private IPs", () => {
    expect(() => assertPublicHttpsUrl("https://localhost/api")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://sub.localhost/")).toThrow(
      /localhost/,
    );
    expect(() => assertPublicHttpsUrl("https://127.0.0.1:8080/")).toThrow(
      /private/,
    );
    expect(() => assertPublicHttpsUrl("https://192.168.1.1/")).toThrow(
      /private/,
    );
    expect(() => assertPublicHttpsUrl("https://10.0.0.5/")).toThrow(/private/);
    expect(() => assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/"))
      .toThrow(/private/);
  });

  test("allows loopback HTTP in testing mode when requested", () => {
    const url = assertPublicHttpsUrl("http://127.0.0.1:8787/test", true);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.protocol).toBe("http:");
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("&lt;div&gt;&amp;&quot;&#39;&nbsp;&copy;&#65;&#x42;")).toBe(
      '<div>&"\' ©AB',
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

  test("rejects unsupported content types like images", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

    await expect(safeFetchDocument("https://example.com/pic.png", fakeFetch))
      .rejects.toThrow(/Unsupported content type/);
  });

  test("truncates content exceeding character limit", async () => {
    const hugeText = "<p>" + "A".repeat(MAX_EXTRACTED_CHARS_PER_FETCH + 5000) + "</p>";
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(hugeText, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    const doc = await safeFetchDocument("https://example.com/huge", fakeFetch);
    expect(doc.text).toContain("[Content truncated at 40,000 characters]");
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

  test("registers web_search and web_fetch commands with untrusted result framing", async () => {
    const state = createWebToolsSessionState();
    const fakeCall = async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          results: [{
            title: "Tavily Doc",
            url: "https://docs.tavily.com",
            content: "Official Tavily Documentation",
          }],
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
    const searchRes = await searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "tavily docs" },
    }, { authzBasis: "test" });

    expect(searchRes).toContain("<untrusted-mcp-result>");
    expect(searchRes).toContain("Tavily Doc");
    expect(searchRes).toContain("ID: s1");
    expect(state.sourceUrlMap.get("s1")).toBe("https://docs.tavily.com");

    // Test follow-up web_fetch using sourceId "s1"
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;

    // Test fetching directly
    const globalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("<h1>Tavily API Reference</h1><p>API details...</p>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    try {
      const fetchRes = await fetchCmd.executor({
        callId: "call_2",
        commandId: "web_fetch",
        caller: { principalId: "operator", principalType: "human" },
        arguments: { sourceId: "s1" },
      }, { authzBasis: "test" });

      expect(fetchRes).toContain("<untrusted-mcp-result>");
      expect(fetchRes).toContain("# Tavily API Reference");
      expect(fetchRes).toContain("API details...");
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  test("enforces max search and fetch calls per turn", async () => {
    const state = createWebToolsSessionState();
    state.searchCount = MAX_SEARCH_CALLS_PER_TURN;
    const commands = buildWebCommands(server, "test_token", {}, state);
    const searchCmd = commands.find((c) => c.id === "web_search")!;

    await expect(searchCmd.executor({
      callId: "call_1",
      commandId: "web_search",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { query: "overflow" },
    }, { authzBasis: "test" })).rejects.toThrow(/Web search call limit exceeded/);

    state.fetchCount = MAX_FETCH_CALLS_PER_TURN;
    const fetchCmd = commands.find((c) => c.id === "web_fetch")!;
    await expect(fetchCmd.executor({
      callId: "call_2",
      commandId: "web_fetch",
      caller: { principalId: "operator", principalType: "human" },
      arguments: { url: "https://example.com" },
    }, { authzBasis: "test" })).rejects.toThrow(/Web fetch call limit exceeded/);
  });
});
