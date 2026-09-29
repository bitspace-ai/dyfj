import {
  assertEquals,
  assertFalse,
  assertNotMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  createStreamingMarkdownRenderer,
  renderInlineMarkdown,
  renderMarkdownLine,
  visibleWidth,
  wordWrap,
} from "./streaming-markdown.ts";

describe("renderInlineMarkdown", () => {
  it("strips bold markers and applies ANSI when color is on", () => {
    const out = renderInlineMarkdown("say **bold** here", true);
    assertFalse(out.includes("**"));
    assertStringIncludes(out, "\x1b[1mbold\x1b[0m");
  });

  it("strips markers without ANSI when color is off", () => {
    assertStrictEquals(
      renderInlineMarkdown("**bold** and *em*", false),
      "bold and em",
    );
    assertStrictEquals(renderInlineMarkdown("`code`", false), "code");
  });

  it("handles italic with underscore", () => {
    assertStrictEquals(renderInlineMarkdown("_emphasis_", false), "emphasis");
  });

  it("leaves snake_case identifiers intact in prose", () => {
    assertStrictEquals(
      renderInlineMarkdown("set approve_paid_default in config", false),
      "set approve_paid_default in config",
    );
    assertStrictEquals(
      renderInlineMarkdown("_real emphasis_ not approve_paid_default", false),
      "real emphasis not approve_paid_default",
    );
  });

  it("renders safe links as labeled terminal hyperlinks", () => {
    const out = renderInlineMarkdown(
      "See [the guide](https://example.com/guide).",
      true,
    );
    assertFalse(out.includes("[the guide]("));
    assertStringIncludes(out, "\x1b]8;;https://example.com/guide\x07");
    assertStringIncludes(out, "the guide");
  });

  it("keeps the destination visible in plain output", () => {
    assertStrictEquals(
      renderInlineMarkdown("[guide](README.md)", false),
      "guide (README.md)",
    );
  });

  it("keeps safe unsupported destinations visible in color output", () => {
    const relative = renderInlineMarkdown("[guide](README.md)", true);
    const unsupportedScheme = renderInlineMarkdown(
      "[file](ftp://example.com/a)",
      true,
    );
    assertStringIncludes(relative, "guide\x1b[0m (README.md)");
    assertStringIncludes(
      unsupportedScheme,
      "file\x1b[0m (ftp://example.com/a)",
    );
    assertFalse(relative.includes("\x1b]8;;"));
    assertFalse(unsupportedScheme.includes("\x1b]8;;"));
  });

  it("never admits terminal controls from a link target", () => {
    const out = renderInlineMarkdown(
      "[safe](https://example.com/\x1b]8;;bad)",
      true,
    );
    assertFalse(out.includes("\x1b]8;;https://example.com/"));
    assertStringIncludes(out, "safe");
  });
});

describe("renderMarkdownLine", () => {
  it("renders ATX headers without hash markers", () => {
    assertStrictEquals(
      renderMarkdownLine("## Section", false, false).text,
      "Section\n",
    );
    assertStrictEquals(
      renderMarkdownLine("# Title", false, false).text,
      "Title\n",
    );
  });

  it("re-asserts header styling after inline code spans", () => {
    const { text } = renderMarkdownLine("# Hello `code` rest", false, true);
    assertStringIncludes(text, "\x1b[1m\x1b[96mHello \x1b[36mcode\x1b[0m");
    assertStringIncludes(text, "\x1b[0m\x1b[1m\x1b[96m rest");
  });

  it("renders list bullets without dash markers", () => {
    const { text } = renderMarkdownLine("- first item", false, false);
    assertStrictEquals(text, "• first item\n");
    assertFalse(text.includes("- first"));
  });

  it("renders ordered lists with the numeric marker", () => {
    assertStrictEquals(
      renderMarkdownLine("1. step one", false, false).text,
      "1. step one\n",
    );
  });

  it("renders plus-marked lists with hanging indentation", () => {
    const rendered = renderMarkdownLine("+ one two three four", false, false);
    assertStrictEquals(rendered.text, "• one two three four\n");
    assertStrictEquals(rendered.continuationIndent, "  ");
    assertStrictEquals(
      wordWrap(rendered.text.trimEnd(), 10, rendered.continuationIndent),
      "• one two\n  three\n  four",
    );
  });

  it("toggles fenced code blocks and emits content verbatim", () => {
    let r = renderMarkdownLine("```ts", false, false);
    assertStrictEquals(r.inCodeBlock, true);
    assertStrictEquals(r.text, "");

    r = renderMarkdownLine('const x = "**not bold**";', true, false);
    assertStrictEquals(r.inCodeBlock, true);
    assertStringIncludes(r.text, '"**not bold**"');

    r = renderMarkdownLine("```", true, false);
    assertStrictEquals(r.inCodeBlock, false);
    assertStrictEquals(r.text, "");
  });

  it("renders block quotes and horizontal rules", () => {
    const quote = renderMarkdownLine("> cited text", false, false);
    assertStrictEquals(quote.text, "│ cited text\n");
    assertStrictEquals(quote.continuationIndent, "  ");
    assertStrictEquals(
      renderMarkdownLine("---", false, false).text,
      `${"─".repeat(24)}\n`,
    );
  });
});

describe("wordWrap", () => {
  it("wraps at spaces without mid-word breaks", () => {
    const wrapped = wordWrap("one two three four five", 10);
    assertStrictEquals(wrapped, "one two\nthree four\nfive");
  });

  it("counts visible width ignoring ANSI", () => {
    const styled = "\x1b[1mhello\x1b[0m world";
    assertStrictEquals(visibleWidth(styled), 11);
    assertStrictEquals(wordWrap(styled, 8), "\x1b[1mhello\x1b[0m\nworld");
  });

  it("counts OSC hyperlinks by their visible label only", () => {
    const linked = "\x1b]8;;https://example.com\x07guide\x1b]8;;\x07";
    assertStrictEquals(visibleWidth(linked), 5);
  });

  it("uses a hanging indent for wrapped list content", () => {
    assertStrictEquals(
      wordWrap("• one two three four", 10, "  "),
      "• one two\n  three\n  four",
    );
  });

  it("bounds an overlong ordered-list indent without looping", () => {
    const marker = "1".repeat(100);
    const rendered = renderMarkdownLine(`${marker}. one two`, false, false);
    const wrapped = wordWrap(
      rendered.text.trimEnd(),
      100,
      rendered.continuationIndent,
    );
    assertStringIncludes(wrapped, "one two");
    assertEquals((wrapped.split("\n")).length, 2);
  });

  it("keeps quote/list continuation indentation bounded in narrow columns", () => {
    const quote = renderMarkdownLine("> one two three four", false, false);
    const list = renderMarkdownLine("  1. one two three four", false, false);
    assertStrictEquals(
      wordWrap(quote.text.trimEnd(), 5, quote.continuationIndent),
      "│ one\n  two\nthree\nfour",
    );
    assertStrictEquals(
      wordWrap(list.text.trimEnd(), 5, list.continuationIndent),
      "  1.\none\ntwo\nthree\nfour",
    );
  });
});

describe("createStreamingMarkdownRenderer", () => {
  it("buffers partial lines across deltas", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("## Hel");
    assertEquals(chunks.length, 0);
    r.push("lo\n");
    assertStrictEquals(chunks.join(""), "Hello\n");
  });

  it("flush emits a trailing line without a newline", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("**tail**");
    r.flush();
    assertStrictEquals(chunks.join(""), "tail\n");
  });

  it("streams line-by-line as newlines arrive", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("line one\nline ");
    assertEquals(chunks, ["line one\n"]);
    r.push("two\n");
    assertEquals(chunks, ["line one\n", "line two\n"]);
  });

  it("reset drops the buffered partial line", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("stale partial with no newline");
    r.reset();
    r.push("fresh line\n");
    r.flush();
    assertStrictEquals(chunks.join(""), "fresh line\n");
  });

  it("reset closes a half-open code fence so replacement text parses fresh", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    // The stale stream opened a fence that never closed. Without reset the
    // replacement's markdown would render verbatim as code-block lines.
    r.push("```\nstale code\n");
    r.reset();
    r.push("**bold** replacement\n");
    assertStrictEquals(chunks.join(""), "stale code\nbold replacement\n");
  });

  it("renders a typical companion shape end-to-end", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push(
      "## Tools\n\n- **read_file** — read a path\n- `list_files` — list dir\n",
    );
    r.flush();
    const out = chunks.join("");
    assertNotMatch(out, /##|\*\*|`|^- /m);
    assertStringIncludes(out, "Tools");
    assertStringIncludes(out, "read_file");
    assertStringIncludes(out, "list_files");
    assertStringIncludes(out, "•");
  });
});
