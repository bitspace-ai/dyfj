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
  beforeWrite?: () => void;
  afterWrite?: () => void;
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
const LINK = "\x1b[4m\x1b[96m";
const QUOTE = "\x1b[2m";

/** Visible width of a string that may contain ANSI escape sequences. */
export function visibleWidth(text: string): number {
  // deno-lint-ignore no-control-regex
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .length;
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
    if (text[i] === "[") {
      const labelEnd = text.indexOf("](", i + 1);
      const targetEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
      if (labelEnd !== -1 && targetEnd !== -1) {
        const label = text.slice(i + 1, labelEnd);
        const target = text.slice(labelEnd + 2, targetEnd);
        if (label.length > 0 && target.length > 0) {
          const renderedLabel = renderInlineMarkdown(label, color);
          const uri = terminalLinkUri(target);
          if (color && uri !== null) {
            out += `\x1b]8;;${uri}\x07${
              styled(renderedLabel, LINK, true)
            }\x1b]8;;\x07`;
          } else if (color) {
            const visibleTarget = terminalLinkFallback(target);
            out += styled(renderedLabel, LINK, true);
            if (visibleTarget !== null) out += ` (${visibleTarget})`;
          } else {
            const visibleTarget = terminalLinkFallback(target);
            out += visibleTarget === null
              ? renderedLabel
              : `${renderedLabel} (${visibleTarget})`;
          }
          i = targetEnd + 1;
          continue;
        }
      }
    }
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

/** Permit only bounded, control-free link destinations in terminal OSC 8. */
function terminalLinkUri(target: string): string | null {
  if (terminalLinkFallback(target) === null) return null;
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return target;
  if (target.startsWith("/")) {
    const path = target.replace(/:\d+$/, "");
    return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  return null;
}

/** A safe, bounded visible fallback for non-OSC-8 link destinations. */
function terminalLinkFallback(target: string): string | null {
  if (target.length > 2_048 || /[\x00-\x1f\x7f-\x9f]/.test(target)) return null;
  const maxVisibleTargetLength = 256;
  return target.length <= maxVisibleTargetLength
    ? target
    : `${target.slice(0, maxVisibleTargetLength - 1)}…`;
}

export interface RenderLineResult {
  text: string;
  inCodeBlock: boolean;
  continuationIndent?: string;
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

  const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (list) {
    const indent = list[1];
    const marker = list[2].endsWith(".") ? list[2] : "•";
    const body = renderInlineMarkdown(list[3], color);
    const bullet = styled(marker, DIM, color);
    return {
      text: `${indent}${bullet} ${body}\n`,
      inCodeBlock: false,
      continuationIndent: `${indent}${" ".repeat(marker.length + 1)}`,
    };
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    const prefix = styled("│", QUOTE, color);
    return {
      text: `${prefix} ${renderInlineMarkdown(quote[1], color)}\n`,
      inCodeBlock: false,
      continuationIndent: "  ",
    };
  }

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return {
      text: `${styled("─".repeat(24), DIM, color)}\n`,
      inCodeBlock: false,
    };
  }

  return {
    text: `${renderInlineMarkdown(line, color)}\n`,
    inCodeBlock: false,
  };
}

/** Word-wrap styled text at column width without breaking words mid-token. */
export function wordWrap(
  text: string,
  columns: number,
  continuationIndent = "",
): string {
  if (columns <= 0) return text;
  // An indent that consumes the full line cannot preserve list structure and
  // still leave room for content. Drop it for this line; ordered-list markers
  // are model-controlled and therefore unbounded.
  const boundedIndent = visibleWidth(continuationIndent) < columns
    ? continuationIndent
    : "";
  const inputLines = text.split("\n");
  const wrapped: string[] = [];

  for (const inputLine of inputLines) {
    if (visibleWidth(inputLine) <= columns) {
      wrapped.push(inputLine);
      continue;
    }

    let line = inputLine;
    while (visibleWidth(line) > columns) {
      const previousWidth = visibleWidth(line);
      let width = 0;
      let lastSpaceAt = -1;
      let i = 0;
      while (i < line.length) {
        if (line[i] === "\x1b") {
          const end = ansiSequenceEnd(line, i);
          if (end === -1) break;
          i = end;
          continue;
        }
        const ch = line[i];
        if (ch === " " && width > 0) lastSpaceAt = i;
        width++;
        if (width > columns && lastSpaceAt > 0) {
          const prefix = line.slice(0, lastSpaceAt);
          const remainder = line.slice(lastSpaceAt + 1);
          // A separator inside a continuation indent is not a usable wrap
          // point. Dropping that indent lets the content make progress rather
          // than emitting an empty visual line and reproducing the remainder.
          if (visibleWidth(prefix.trimStart()) === 0) {
            line = remainder;
            break;
          }
          wrapped.push(prefix);
          const continued = `${boundedIndent}${remainder}`;
          // A split must shorten the remainder; otherwise an overlong indent
          // could reproduce the same line forever. Drop indentation only when
          // retaining it would violate that invariant.
          line = visibleWidth(continued) < previousWidth
            ? continued
            : remainder;
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

function ansiSequenceEnd(text: string, start: number): number {
  if (text[start + 1] === "[") {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return -1;
  }
  if (text[start + 1] === "]") {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i + 1;
      if (text[i] === "\x1b" && text[i + 1] === "\\") return i + 2;
    }
  }
  return -1;
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
    const wrapped = wordWrap(
      rendered.text.replace(/\n$/, ""),
      columns,
      rendered.continuationIndent,
    );
    options.beforeWrite?.();
    try {
      options.out(`${wrapped}\n`);
    } finally {
      options.afterWrite?.();
    }
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
