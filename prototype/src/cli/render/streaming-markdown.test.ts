import assert from "node:assert/strict";
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
    assert.ok(!out.includes("**"));
    assert.ok(out.includes("\x1b[1mbold\x1b[0m"), `expected ${JSON.stringify(out)} to include "\\x1b[1mbold\\x1b[0m"`);
  });

  it("strips markers without ANSI when color is off", () => {
    assert.strictEqual(
      renderInlineMarkdown("**bold** and *em*", false),
      "bold and em",
    );
    assert.strictEqual(renderInlineMarkdown("`code`", false), "code");
  });

  it("handles italic with underscore", () => {
    assert.strictEqual(renderInlineMarkdown("_emphasis_", false), "emphasis");
  });

  it("leaves snake_case identifiers intact in prose", () => {
    assert.strictEqual(
      renderInlineMarkdown("set approve_paid_default in config", false),
      "set approve_paid_default in config",
    );
    assert.strictEqual(
      renderInlineMarkdown("_real emphasis_ not approve_paid_default", false),
      "real emphasis not approve_paid_default",
    );
  });

  it("renders safe links as labeled terminal hyperlinks", () => {
    const out = renderInlineMarkdown(
      "See [the guide](https://example.com/guide).",
      true,
    );
    assert.ok(!out.includes("[the guide]("));
    assert.ok(out.includes("\x1b]8;;https://example.com/guide\x07"), `expected ${JSON.stringify(out)} to include "\\x1b]8;;https://example.com/guide\\x07"`);
    assert.ok(out.includes("the guide"), `expected ${JSON.stringify(out)} to include "the guide"`);
  });

  it("keeps the destination visible in plain output", () => {
    assert.strictEqual(
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
    assert.ok(relative.includes("guide\x1b[0m (README.md)"), `expected ${JSON.stringify(relative)} to include "guide\\x1b[0m (README.md)"`);
    assert.ok(unsupportedScheme.includes("file\x1b[0m (ftp://example.com/a)"), `expected ${JSON.stringify(unsupportedScheme)} to include "file\\x1b[0m (ftp://example.com/a)"`);
    assert.ok(!relative.includes("\x1b]8;;"));
    assert.ok(!unsupportedScheme.includes("\x1b]8;;"));
  });

  it("never admits terminal controls from a link target", () => {
    const out = renderInlineMarkdown(
      "[safe](https://example.com/\x1b]8;;bad)",
      true,
    );
    assert.ok(!out.includes("\x1b]8;;https://example.com/"));
    assert.ok(out.includes("safe"), `expected ${JSON.stringify(out)} to include "safe"`);
  });
});

describe("renderMarkdownLine", () => {
  it("renders ATX headers without hash markers", () => {
    assert.strictEqual(
      renderMarkdownLine("## Section", false, false).text,
      "Section\n",
    );
    assert.strictEqual(
      renderMarkdownLine("# Title", false, false).text,
      "Title\n",
    );
  });

  it("re-asserts header styling after inline code spans", () => {
    const { text } = renderMarkdownLine("# Hello `code` rest", false, true);
    assert.ok(text.includes("\x1b[1m\x1b[96mHello \x1b[36mcode\x1b[0m"), `expected ${JSON.stringify(text)} to include "\\x1b[1m\\x1b[96mHello \\x1b[36mcode\\x1b[0m"`);
    assert.ok(text.includes("\x1b[0m\x1b[1m\x1b[96m rest"), `expected ${JSON.stringify(text)} to include "\\x1b[0m\\x1b[1m\\x1b[96m rest"`);
  });

  it("renders list bullets without dash markers", () => {
    const { text } = renderMarkdownLine("- first item", false, false);
    assert.strictEqual(text, "• first item\n");
    assert.ok(!text.includes("- first"));
  });

  it("renders ordered lists with the numeric marker", () => {
    assert.strictEqual(
      renderMarkdownLine("1. step one", false, false).text,
      "1. step one\n",
    );
  });

  it("renders plus-marked lists with hanging indentation", () => {
    const rendered = renderMarkdownLine("+ one two three four", false, false);
    assert.strictEqual(rendered.text, "• one two three four\n");
    assert.strictEqual(rendered.continuationIndent, "  ");
    assert.strictEqual(
      wordWrap(rendered.text.trimEnd(), 10, rendered.continuationIndent),
      "• one two\n  three\n  four",
    );
  });

  it("toggles fenced code blocks and emits content verbatim", () => {
    let r = renderMarkdownLine("```ts", false, false);
    assert.strictEqual(r.inCodeBlock, true);
    assert.strictEqual(r.text, "");

    r = renderMarkdownLine('const x = "**not bold**";', true, false);
    assert.strictEqual(r.inCodeBlock, true);
    assert.ok(r.text.includes('"**not bold**"'), `expected r.text to include '"**not bold**"'`);

    r = renderMarkdownLine("```", true, false);
    assert.strictEqual(r.inCodeBlock, false);
    assert.strictEqual(r.text, "");
  });

  it("renders block quotes and horizontal rules", () => {
    const quote = renderMarkdownLine("> cited text", false, false);
    assert.strictEqual(quote.text, "│ cited text\n");
    assert.strictEqual(quote.continuationIndent, "  ");
    assert.strictEqual(
      renderMarkdownLine("---", false, false).text,
      `${"─".repeat(24)}\n`,
    );
  });
});

describe("wordWrap", () => {
  it("wraps at spaces without mid-word breaks", () => {
    const wrapped = wordWrap("one two three four five", 10);
    assert.strictEqual(wrapped, "one two\nthree four\nfive");
  });

  it("counts visible width ignoring ANSI", () => {
    const styled = "\x1b[1mhello\x1b[0m world";
    assert.strictEqual(visibleWidth(styled), 11);
    assert.strictEqual(wordWrap(styled, 8), "\x1b[1mhello\x1b[0m\nworld");
  });

  it("counts OSC hyperlinks by their visible label only", () => {
    const linked = "\x1b]8;;https://example.com\x07guide\x1b]8;;\x07";
    assert.strictEqual(visibleWidth(linked), 5);
  });

  it("uses a hanging indent for wrapped list content", () => {
    assert.strictEqual(
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
    assert.ok(wrapped.includes("one two"), `expected ${JSON.stringify(wrapped)} to include "one two"`);
    assert.deepStrictEqual((wrapped.split("\n")).length, 2);
  });

  it("keeps quote/list continuation indentation bounded in narrow columns", () => {
    const quote = renderMarkdownLine("> one two three four", false, false);
    const list = renderMarkdownLine("  1. one two three four", false, false);
    assert.strictEqual(
      wordWrap(quote.text.trimEnd(), 5, quote.continuationIndent),
      "│ one\n  two\nthree\nfour",
    );
    assert.strictEqual(
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
    assert.deepStrictEqual(chunks.length, 0);
    r.push("lo\n");
    assert.strictEqual(chunks.join(""), "Hello\n");
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
    assert.strictEqual(chunks.join(""), "tail\n");
  });

  it("streams line-by-line as newlines arrive", () => {
    const chunks: string[] = [];
    const r = createStreamingMarkdownRenderer({
      out: (t) => chunks.push(t),
      color: false,
      columns: 80,
    });
    r.push("line one\nline ");
    assert.deepStrictEqual(chunks, ["line one\n"]);
    r.push("two\n");
    assert.deepStrictEqual(chunks, ["line one\n", "line two\n"]);
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
    assert.strictEqual(chunks.join(""), "fresh line\n");
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
    assert.strictEqual(chunks.join(""), "stale code\nbold replacement\n");
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
    assert.doesNotMatch(out, /##|\*\*|`|^- /m);
    assert.ok(out.includes("Tools"), `expected ${JSON.stringify(out)} to include "Tools"`);
    assert.ok(out.includes("read_file"), `expected ${JSON.stringify(out)} to include "read_file"`);
    assert.ok(out.includes("list_files"), `expected ${JSON.stringify(out)} to include "list_files"`);
    assert.ok(out.includes("•"), `expected ${JSON.stringify(out)} to include "•"`);
  });
});
