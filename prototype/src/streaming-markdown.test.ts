import { describe, expect, test } from "vitest";
import {
  createStreamingMarkdownRenderer,
  renderInlineMarkdown,
  renderMarkdownLine,
  visibleWidth,
  wordWrap,
} from "./streaming-markdown";

describe("renderInlineMarkdown", () => {
  test("strips bold markers and applies ANSI when color is on", () => {
    const out = renderInlineMarkdown("say **bold** here", true);
    expect(out).not.toContain("**");
    expect(out).toContain("\x1b[1mbold\x1b[0m");
  });

  test("strips markers without ANSI when color is off", () => {
    expect(renderInlineMarkdown("**bold** and *em*", false)).toBe("bold and em");
    expect(renderInlineMarkdown("`code`", false)).toBe("code");
  });

  test("handles italic with underscore", () => {
    expect(renderInlineMarkdown("_emphasis_", false)).toBe("emphasis");
  });

  test("leaves snake_case identifiers intact in prose", () => {
    expect(renderInlineMarkdown("set approve_paid_default in config", false))
      .toBe("set approve_paid_default in config");
    expect(renderInlineMarkdown("_real emphasis_ not approve_paid_default", false))
      .toBe("real emphasis not approve_paid_default");
  });

  test("renders safe links as labeled terminal hyperlinks", () => {
    const out = renderInlineMarkdown(
      "See [the guide](https://example.com/guide).",
      true,
    );
    expect(out).not.toContain("[the guide](");
    expect(out).toContain("\x1b]8;;https://example.com/guide\x07");
    expect(out).toContain("the guide");
  });

  test("keeps the destination visible in plain output", () => {
    expect(renderInlineMarkdown("[guide](README.md)", false)).toBe(
      "guide (README.md)",
    );
  });

  test("keeps safe unsupported destinations visible in color output", () => {
    const relative = renderInlineMarkdown("[guide](README.md)", true);
    const unsupportedScheme = renderInlineMarkdown("[file](ftp://example.com/a)", true);
    expect(relative).toContain("guide\x1b[0m (README.md)");
    expect(unsupportedScheme).toContain("file\x1b[0m (ftp://example.com/a)");
    expect(relative).not.toContain("\x1b]8;;");
    expect(unsupportedScheme).not.toContain("\x1b]8;;");
  });

  test("never admits terminal controls from a link target", () => {
    const out = renderInlineMarkdown(
      "[safe](https://example.com/\x1b]8;;bad)",
      true,
    );
    expect(out).not.toContain("\x1b]8;;https://example.com/");
    expect(out).toContain("safe");
  });
});

describe("renderMarkdownLine", () => {
  test("renders ATX headers without hash markers", () => {
    expect(renderMarkdownLine("## Section", false, false).text).toBe("Section\n");
    expect(renderMarkdownLine("# Title", false, false).text).toBe("Title\n");
  });

  test("re-asserts header styling after inline code spans", () => {
    const { text } = renderMarkdownLine("# Hello `code` rest", false, true);
    expect(text).toContain("\x1b[1m\x1b[96mHello \x1b[36mcode\x1b[0m");
    expect(text).toContain("\x1b[0m\x1b[1m\x1b[96m rest");
  });

  test("renders list bullets without dash markers", () => {
    const { text } = renderMarkdownLine("- first item", false, false);
    expect(text).toBe("• first item\n");
    expect(text).not.toContain("- first");
  });

  test("renders ordered lists with the numeric marker", () => {
    expect(renderMarkdownLine("1. step one", false, false).text).toBe("1. step one\n");
  });

  test("renders plus-marked lists with hanging indentation", () => {
    const rendered = renderMarkdownLine("+ one two three four", false, false);
    expect(rendered.text).toBe("• one two three four\n");
    expect(rendered.continuationIndent).toBe("  ");
    expect(wordWrap(rendered.text.trimEnd(), 10, rendered.continuationIndent))
      .toBe("• one two\n  three\n  four");
  });

  test("toggles fenced code blocks and emits content verbatim", () => {
    let r = renderMarkdownLine("```ts", false, false);
    expect(r.inCodeBlock).toBe(true);
    expect(r.text).toBe("");

    r = renderMarkdownLine('const x = "**not bold**";', true, false);
    expect(r.inCodeBlock).toBe(true);
    expect(r.text).toContain('"**not bold**"');

    r = renderMarkdownLine("```", true, false);
    expect(r.inCodeBlock).toBe(false);
    expect(r.text).toBe("");
  });

  test("renders block quotes and horizontal rules", () => {
    const quote = renderMarkdownLine("> cited text", false, false);
    expect(quote.text).toBe("│ cited text\n");
    expect(quote.continuationIndent).toBe("  ");
    expect(renderMarkdownLine("---", false, false).text).toBe(
      `${"─".repeat(24)}\n`,
    );
  });
});

describe("wordWrap", () => {
  test("wraps at spaces without mid-word breaks", () => {
    const wrapped = wordWrap("one two three four five", 10);
    expect(wrapped).toBe("one two\nthree four\nfive");
  });

  test("counts visible width ignoring ANSI", () => {
    const styled = "\x1b[1mhello\x1b[0m world";
    expect(visibleWidth(styled)).toBe(11);
    expect(wordWrap(styled, 8)).toBe("\x1b[1mhello\x1b[0m\nworld");
  });

  test("counts OSC hyperlinks by their visible label only", () => {
    const linked = "\x1b]8;;https://example.com\x07guide\x1b]8;;\x07";
    expect(visibleWidth(linked)).toBe(5);
  });

  test("uses a hanging indent for wrapped list content", () => {
    expect(wordWrap("• one two three four", 10, "  ")).toBe(
      "• one two\n  three\n  four",
    );
  });

  test("bounds an overlong ordered-list indent without looping", () => {
    const marker = "1".repeat(100);
    const rendered = renderMarkdownLine(`${marker}. one two`, false, false);
    const wrapped = wordWrap(rendered.text.trimEnd(), 100, rendered.continuationIndent);
    expect(wrapped).toContain("one two");
    expect(wrapped.split("\n")).toHaveLength(2);
  });

  test("keeps quote/list continuation indentation bounded in narrow columns", () => {
    const quote = renderMarkdownLine("> one two three four", false, false);
    const list = renderMarkdownLine("  1. one two three four", false, false);
    expect(wordWrap(quote.text.trimEnd(), 5, quote.continuationIndent)).toBe(
      "│ one\n  two\nthree\nfour",
    );
    expect(wordWrap(list.text.trimEnd(), 5, list.continuationIndent)).toBe(
      "  1.\none\ntwo\nthree\nfour",
    );
  });
});

describe("createStreamingMarkdownRenderer", () => {
  test("buffers partial lines across deltas", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("## Hel");
    expect(chunks).toHaveLength(0);
    r.push("lo\n");
    expect(chunks.join("")).toBe("Hello\n");
  });

  test("flush emits a trailing line without a newline", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("**tail**");
    r.flush();
    expect(chunks.join("")).toBe("tail\n");
  });

  test("streams line-by-line as newlines arrive", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("line one\nline ");
    expect(chunks).toEqual(["line one\n"]);
    r.push("two\n");
    expect(chunks).toEqual(["line one\n", "line two\n"]);
  });

  test("reset drops the buffered partial line", () => {
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
    expect(chunks.join("")).toBe("fresh line\n");
  });

  test("reset closes a half-open code fence so replacement text parses fresh", () => {
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
    expect(chunks.join("")).toBe("stale code\nbold replacement\n");
  });

  test("renders a typical companion shape end-to-end", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("## Tools\n\n- **read_file** — read a path\n- `list_files` — list dir\n");
    r.flush();
    const out = chunks.join("");
    expect(out).not.toMatch(/##|\*\*|`|^- /m);
    expect(out).toContain("Tools");
    expect(out).toContain("read_file");
    expect(out).toContain("list_files");
    expect(out).toContain("•");
  });
});
