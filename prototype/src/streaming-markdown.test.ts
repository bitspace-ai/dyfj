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
});

describe("renderMarkdownLine", () => {
  test("renders ATX headers without hash markers", () => {
    expect(renderMarkdownLine("## Section", false, false).text).toBe("Section\n");
    expect(renderMarkdownLine("# Title", false, false).text).toBe("Title\n");
  });

  test("renders list bullets without dash markers", () => {
    const { text } = renderMarkdownLine("- first item", false, false);
    expect(text).toBe("• first item\n");
    expect(text).not.toContain("- first");
  });

  test("renders ordered lists with the numeric marker", () => {
    expect(renderMarkdownLine("1. step one", false, false).text).toBe("1. step one\n");
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
