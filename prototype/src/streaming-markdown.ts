/**
 * Line-buffered streaming markdown renderer for the dyfj CLI.
 *
 * Deltas arrive token-by-token; we accumulate until a newline, then render
 * the complete line (inline markers are whole within a line). Fenced code
 * blocks toggle verbatim emission; flush() emits any trailing partial line.
 */

export interface StreamingMarkdownOptions {
  out: (text: string) => void;
  color: boolean;
  columns?: number;
}

export interface StreamingMarkdownRenderer {
  push(delta: string): void;
  flush(): void;
  /**
   * Discard buffered-but-unrendered input and re-arm the line state (fenced
   * code toggling) for a fresh document. For the superseding-retry signal:
   * the text that replaces the stale stream starts from a clean parse state,
   * never inheriting a half-open code fence or partial line from it.
   */
  reset(): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CODE = "\x1b[36m";
const HEADER = "\x1b[1m\x1b[96m";

/** Visible width of a string that may contain ANSI escape sequences. */
export function visibleWidth(text: string): number {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function styled(text: string, codes: string, color: boolean): string {
  if (!color || text.length === 0) return text;
  return `${codes}${text}${RESET}`;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** CommonMark-style: '_' emphasis only when delimiters are not intraword. */
function canOpenUnderscoreEmphasis(text: string, i: number): boolean {
  const before = i > 0 ? text[i - 1] : "";
  return before === "" || !isWordChar(before);
}

function canCloseUnderscoreEmphasis(text: string, end: number): boolean {
  const after = end + 1 < text.length ? text[end + 1] : "";
  return after === "" || !isWordChar(after);
}

/** Re-apply outer ANSI codes after inline span resets (e.g. header + `code`). */
function withPersistentStyle(
  body: string,
  codes: string,
  color: boolean,
): string {
  if (!color) return body;
  return `${codes}${body.replaceAll(RESET, `${RESET}${codes}`)}${RESET}`;
}

/** Parse inline markdown (**bold**, *italic*, `code`) into styled text. */
export function renderInlineMarkdown(text: string, color: boolean): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        out += styled(text.slice(i + 2, end), BOLD, color);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += styled(text.slice(i + 1, end), CODE, color);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && text[end + 1] !== "*") {
        out += styled(text.slice(i + 1, end), ITALIC, color);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "_" && text[i + 1] !== "_" &&
      canOpenUnderscoreEmphasis(text, i)) {
      let end = text.indexOf("_", i + 1);
      while (end !== -1) {
        if (canCloseUnderscoreEmphasis(text, end) && end > i + 1) {
          out += styled(text.slice(i + 1, end), ITALIC, color);
          i = end + 1;
          break;
        }
        end = text.indexOf("_", end + 1);
      }
      if (end !== -1) continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

export interface RenderLineResult {
  text: string;
  inCodeBlock: boolean;
}

/** Render one markdown line; toggles fenced-code state on ``` fences. */
export function renderMarkdownLine(
  line: string,
  inCodeBlock: boolean,
  color: boolean,
): RenderLineResult {
  const fence = line.trimStart().startsWith("```");
  if (fence) {
    return { text: "", inCodeBlock: !inCodeBlock };
  }
  if (inCodeBlock) {
    const body = styled(line, CODE, color);
    return { text: `${body}\n`, inCodeBlock: true };
  }

  const header = line.match(/^(#{1,6})\s+(.*)$/);
  if (header) {
    const level = header[1].length;
    const codes = level <= 1 ? HEADER : BOLD;
    const body = renderInlineMarkdown(header[2], color);
    const prefix = withPersistentStyle(body, codes, color);
    return { text: `${prefix}\n`, inCodeBlock: false };
  }

  const list = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (list) {
    const indent = list[1];
    const marker = list[2].endsWith(".") ? list[2] : "•";
    const body = renderInlineMarkdown(list[3], color);
    const bullet = styled(marker, DIM, color);
    return { text: `${indent}${bullet} ${body}\n`, inCodeBlock: false };
  }

  return {
    text: `${renderInlineMarkdown(line, color)}\n`,
    inCodeBlock: false,
  };
}

/** Word-wrap styled text at column width without breaking words mid-token. */
export function wordWrap(text: string, columns: number): string {
  if (columns <= 0) return text;
  const inputLines = text.split("\n");
  const wrapped: string[] = [];

  for (const inputLine of inputLines) {
    if (visibleWidth(inputLine) <= columns) {
      wrapped.push(inputLine);
      continue;
    }

    let line = inputLine;
    while (visibleWidth(line) > columns) {
      let width = 0;
      let lastSpaceAt = -1;
      let i = 0;
      while (i < line.length) {
        if (line[i] === "\x1b") {
          const end = line.indexOf("m", i);
          if (end === -1) break;
          i = end + 1;
          continue;
        }
        const ch = line[i];
        if (ch === " " && width > 0) lastSpaceAt = i;
        width++;
        if (width > columns && lastSpaceAt > 0) {
          wrapped.push(line.slice(0, lastSpaceAt));
          line = line.slice(lastSpaceAt + 1);
          break;
        }
        i++;
      }
      if (visibleWidth(line) <= columns) break;
      if (lastSpaceAt <= 0) break;
    }
    wrapped.push(line);
  }

  return wrapped.join("\n");
}

export function createStreamingMarkdownRenderer(
  options: StreamingMarkdownOptions,
): StreamingMarkdownRenderer {
  const columns = options.columns ?? 80;
  let buffer = "";
  let inCodeBlock = false;

  function emitLine(line: string): void {
    const rendered = renderMarkdownLine(line, inCodeBlock, options.color);
    inCodeBlock = rendered.inCodeBlock;
    if (rendered.text.length === 0) return;
    const wrapped = wordWrap(rendered.text.replace(/\n$/, ""), columns);
    options.out(`${wrapped}\n`);
  }

  return {
    push(delta: string): void {
      buffer += delta;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        emitLine(line);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emitLine(buffer);
        buffer = "";
      }
    },
    reset(): void {
      buffer = "";
      inCodeBlock = false;
    },
  };
}
