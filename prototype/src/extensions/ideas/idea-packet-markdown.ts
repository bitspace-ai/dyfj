// Markdown rendering for Work Packets, and the text sanitizers that keep
// operator- and model-supplied text from breaking the packet's structure.

import { stripAnsiEscapes } from "../../kernel/mod.ts";
import type { WorkbenchWorkPacket } from "./idea-packet-types.ts";

function countPrecedingBackslashes(str: string, index: number): number {
  let count = 0;
  for (let k = index - 1; k >= 0 && str[k] === "\\"; k--) {
    count++;
  }
  return count;
}

function sanitizeHtmlHeadingsOutsideCodeSpans(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`" && countPrecedingBackslashes(text, i) % 2 === 0) {
      let openLen = 0;
      while (i + openLen < text.length && text[i + openLen] === "`") {
        openLen++;
      }
      const openTicks = text.slice(i, i + openLen);
      let closeIdx = -1;
      let j = i + openLen;
      while (j < text.length) {
        if (text[j] === "`" && countPrecedingBackslashes(text, j) % 2 === 0) {
          let closeLen = 0;
          while (j + closeLen < text.length && text[j + closeLen] === "`") {
            closeLen++;
          }
          if (closeLen === openLen) {
            closeIdx = j;
            break;
          }
          j += closeLen;
        } else {
          j++;
        }
      }
      if (closeIdx !== -1) {
        const span = text.slice(i, closeIdx + openLen);
        result += span;
        i = closeIdx + openLen;
        continue;
      } else {
        result += openTicks;
        i += openLen;
        continue;
      }
    } else if (text[i] === "<") {
      const sub = text.slice(i);
      const match = sub.match(/^<(\/?[hH][1-6](?:[\s\r\n/][^>]*)?)>/);
      if (match) {
        result += `&lt;${match[1]}&gt;`;
        i += match[0].length;
        continue;
      } else {
        result += "<";
        i++;
        continue;
      }
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

function parseCodeFence(
  line: string,
): { prefix: string; fence: string; info: string } | null {
  const containerMatch = line.match(
    /^((?:[ ]{0,3}(?:>[ ]*|[*+-][ ]+|\d+[.)][ ]+))+)[ ]{0,3}(`{3,}|~{3,})(.*)$/,
  );
  if (containerMatch) {
    return {
      prefix: containerMatch[1],
      fence: containerMatch[2],
      info: containerMatch[3],
    };
  }
  const rootMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
  if (rootMatch) {
    return { prefix: "", fence: rootMatch[1], info: rootMatch[2] };
  }
  return null;
}

function parseCloseCodeFence(
  line: string,
): { prefix: string; fence: string } | null {
  const containerMatch = line.match(
    /^((?:[ ]{0,3}(?:>[ ]*|[*+-][ ]+|\d+[.)][ ]+))+)[ ]{0,3}(`{3,}|~{3,})[ ]*$/,
  );
  if (containerMatch) {
    return { prefix: containerMatch[1], fence: containerMatch[2] };
  }
  const spaceMatch = line.match(/^([ ]*)(`{3,}|~{3,})[ ]*$/);
  if (spaceMatch) {
    return { prefix: spaceMatch[1], fence: spaceMatch[2] };
  }
  return null;
}

function matchesContainerPrefix(
  linePrefix: string,
  openPrefix: string,
): boolean {
  if (linePrefix.includes("\t")) return false;
  if (openPrefix === "") {
    // Root-level closing code fences allow only 0 to 3 literal spaces (CommonMark § 4.5)
    return /^[ ]{0,3}$/.test(linePrefix);
  }
  const normLine = linePrefix.replace(/[ \t]+/g, " ").trim();
  const normOpen = openPrefix.replace(/[ \t]+/g, " ").trim();
  if (normLine === normOpen) return true;
  const lineGt = linePrefix.replace(/[^>]/g, "").length;
  const openGt = openPrefix.replace(/[^>]/g, "").length;
  if (openGt > 0) {
    if (lineGt !== openGt) return false;
    const afterGt = linePrefix.slice(linePrefix.lastIndexOf(">") + 1);
    const openAfterGt = openPrefix.slice(openPrefix.lastIndexOf(">") + 1);
    const normAfterGt = afterGt.replace(/[ \t]+/g, " ").trim();
    const normOpenAfterGt = openAfterGt.replace(/[ \t]+/g, " ").trim();
    if (normAfterGt === normOpenAfterGt) return true;
    if (/^[ ]+$/.test(afterGt)) {
      return afterGt.length >= openAfterGt.length &&
        afterGt.length <= openAfterGt.length + 3;
    }
    return false;
  }
  // List container without blockquotes: closing line inside list item uses spaces matching list marker width + 0-3 spaces
  if (/^[ ]+$/.test(linePrefix)) {
    return linePrefix.length >= openPrefix.length &&
      linePrefix.length <= openPrefix.length + 3;
  }
  return false;
}

function hasContainerPrefix(line: string, openPrefix: string): boolean {
  if (openPrefix === "") return true;
  if (line.trim().length === 0) return false;
  const openLeadingMatch = openPrefix.match(/^([ ]{0,3}(?:>[ ]*)+)/);
  if (openLeadingMatch) {
    const lineLeadingMatch = line.match(/^([ ]{0,3}(?:>[ ]*)+)/);
    if (!lineLeadingMatch) return false;
    const lineGt = lineLeadingMatch[1].replace(/[^>]/g, "").length;
    const openGt = openLeadingMatch[1].replace(/[^>]/g, "").length;
    if (lineGt < openGt) return false;
    const afterGt = line.slice(lineLeadingMatch[1].length);
    const openAfterGt = openPrefix.slice(openLeadingMatch[1].length);
    if (openAfterGt.trim().length === 0) return true;
    const normAfterGt = afterGt.replace(/[ \t]+/g, " ").trim();
    const normOpenAfterGt = openAfterGt.replace(/[ \t]+/g, " ").trim();
    if (normAfterGt.startsWith(normOpenAfterGt)) return true;
    return /^[ ]+/.test(afterGt) &&
      (afterGt.match(/^[ ]+/)?.[0].length ?? 0) >= openAfterGt.length;
  }
  if (line.startsWith(openPrefix)) return true;
  const listIndent = " ".repeat(openPrefix.length);
  return line.startsWith(listIndent);
}

function findHeadingPrefixEnd(line: string): number {
  let i = 0;
  const len = line.length;
  while (i < len) {
    let spaceCount = 0;
    let j = i;
    while (j < len && (line[j] === " " || line[j] === "\t") && spaceCount < 3) {
      spaceCount++;
      j++;
    }
    if (j < len && line[j] === ">") {
      i = j + 1;
      while (i < len && (line[i] === " " || line[i] === "\t")) {
        i++;
      }
      continue;
    }
    if (
      j < len &&
      (line[j] === "*" || line[j] === "-" || line[j] === "+") &&
      j + 1 < len &&
      (line[j + 1] === " " || line[j + 1] === "\t")
    ) {
      i = j + 2;
      while (i < len && (line[i] === " " || line[i] === "\t")) {
        i++;
      }
      continue;
    }
    if (j < len && line[j] >= "0" && line[j] <= "9") {
      let d = j;
      while (d < len && line[d] >= "0" && line[d] <= "9" && d - j < 9) {
        d++;
      }
      if (
        d < len &&
        (line[d] === "." || line[d] === ")") &&
        d + 1 < len &&
        (line[d + 1] === " " || line[d + 1] === "\t")
      ) {
        i = d + 2;
        while (i < len && (line[i] === " " || line[i] === "\t")) {
          i++;
        }
        continue;
      }
    }
    break;
  }

  let postSpaces = 0;
  while (i < len && (line[i] === " " || line[i] === "\t") && postSpaces < 3) {
    postSpaces++;
    i++;
  }
  return i;
}

function escapeMarkdownHeadingLine(line: string): string {
  const prefixEnd = findHeadingPrefixEnd(line);
  const rest = line.slice(prefixEnd);
  if (rest.startsWith("#")) {
    const hashesMatch = rest.match(/^(#+)/);
    if (hashesMatch) {
      const prefix = line.slice(0, prefixEnd);
      const hashes = hashesMatch[1];
      const remainder = rest.slice(hashes.length);
      return `${prefix}\\${hashes}${remainder}`;
    }
  }
  if (/^[=-]+[ \t]*$/.test(rest)) {
    const prefix = line.slice(0, prefixEnd);
    return `${prefix}\\${rest}`;
  }
  return line;
}

function sanitizeMarkdownHeading(text: string): string {
  const clean = stripAnsiEscapes(text)
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  const lines = clean.split("\n");
  const result: string[] = [];
  let openChar: string | null = null;
  let openCount = 0;
  let openPrefix = "";
  let nonFenceBuffer: string[] = [];

  const flushNonFenceBuffer = () => {
    if (nonFenceBuffer.length === 0) return;
    const blockText = nonFenceBuffer.join("\n");
    const escaped = sanitizeHtmlHeadingsOutsideCodeSpans(blockText);
    result.push(...escaped.split("\n"));
    nonFenceBuffer = [];
  };

  for (const line of lines) {
    if (
      openChar && openPrefix !== "" && !hasContainerPrefix(line, openPrefix)
    ) {
      openChar = null;
      openCount = 0;
      openPrefix = "";
    }

    if (!openChar) {
      const fenceMatch = parseCodeFence(line);
      if (fenceMatch) {
        const prefix = fenceMatch.prefix;
        const fence = fenceMatch.fence;
        const info = fenceMatch.info;
        if (fence[0] !== "`" || !info.includes("`")) {
          flushNonFenceBuffer();
          openPrefix = prefix;
          openChar = fence[0];
          openCount = fence.length;
          result.push(line);
          continue;
        }
      }

      if (/^[ ]{4,}/.test(line)) {
        nonFenceBuffer.push(line);
        continue;
      }

      // Outside code fences: escape ATX and Setext headings
      const sanitizedLine = escapeMarkdownHeadingLine(line);

      nonFenceBuffer.push(sanitizedLine);
    } else {
      const closeMatch = parseCloseCodeFence(line);
      if (
        closeMatch &&
        matchesContainerPrefix(closeMatch.prefix, openPrefix)
      ) {
        const fence = closeMatch.fence;
        if (fence[0] === openChar && fence.length >= openCount) {
          openChar = null;
          openCount = 0;
          openPrefix = "";
        }
      }
      result.push(line);
    }
  }
  flushNonFenceBuffer();
  return result.join("\n");
}

export function sanitizeSingleLine(text: string): string {
  return stripAnsiEscapes(text)
    .replace(/[\r\n\t\x00-\x1F\x7F-\x9F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeCodeSpanText(str: string): string {
  return stripAnsiEscapes(str)
    .replace(/[\r\n\x00-\x1F\x7F-\x9F]/g, "")
    .trim();
}

export function sanitizeCriterion(text: string): string {
  const noControls = stripAnsiEscapes(text)
    .replace(/[\r\n\t\x00-\x1F\x7F-\x9F]/g, " ");
  let result = "";
  let i = 0;
  while (i < noControls.length) {
    if (
      noControls[i] === "`" &&
      countPrecedingBackslashes(noControls, i) % 2 === 0
    ) {
      let tickCount = 0;
      while (
        i + tickCount < noControls.length && noControls[i + tickCount] === "`"
      ) {
        tickCount++;
      }
      let closeIdx = -1;
      let j = i + tickCount;
      while (j < noControls.length) {
        if (
          noControls[j] === "`" &&
          countPrecedingBackslashes(noControls, j) % 2 === 0
        ) {
          let closeCount = 0;
          while (
            j + closeCount < noControls.length &&
            noControls[j + closeCount] === "`"
          ) {
            closeCount++;
          }
          if (closeCount === tickCount) {
            closeIdx = j;
            break;
          }
          j += closeCount;
        } else {
          j++;
        }
      }
      if (closeIdx !== -1) {
        const span = noControls.slice(i, closeIdx + tickCount);
        result += span;
        i = closeIdx + tickCount;
        continue;
      }
      result += noControls.slice(i, i + tickCount);
      i += tickCount;
    } else if (noControls[i] === "<") {
      const sub = noControls.slice(i);
      const match = sub.match(/^<(\/?[hH][1-6](?:[\s\r\n/][^>]*)?)>/);
      if (match) {
        result += `&lt;${match[1]}&gt;`;
        i += match[0].length;
      } else {
        result += "<";
        i++;
      }
    } else if (/\s/.test(noControls[i])) {
      if (!result.endsWith(" ") && result.length > 0) {
        result += " ";
      }
      while (i < noControls.length && /\s/.test(noControls[i])) {
        i++;
      }
    } else {
      result += noControls[i];
      i++;
    }
  }
  return result.trim();
}

export function closeDanglingFences(text: string): string {
  const clean = stripAnsiEscapes(text)
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  const lines = clean.split("\n");
  let openChar: string | null = null;
  let openCount = 0;
  let openPrefix = "";
  for (const line of lines) {
    if (
      openChar && openPrefix !== "" && !hasContainerPrefix(line, openPrefix)
    ) {
      openChar = null;
      openCount = 0;
      openPrefix = "";
    }
    if (!openChar) {
      const fenceMatch = parseCodeFence(line);
      if (fenceMatch) {
        const prefix = fenceMatch.prefix;
        const fence = fenceMatch.fence;
        const info = fenceMatch.info;
        if (fence[0] !== "`" || !info.includes("`")) {
          openPrefix = prefix;
          openChar = fence[0];
          openCount = fence.length;
        }
      }
    } else {
      const closeMatch = parseCloseCodeFence(line);
      if (
        closeMatch &&
        matchesContainerPrefix(closeMatch.prefix, openPrefix)
      ) {
        const fence = closeMatch.fence;
        if (fence[0] === openChar && fence.length >= openCount) {
          openChar = null;
          openCount = 0;
          openPrefix = "";
        }
      }
    }
  }
  if (openChar) {
    const closePrefix = openPrefix.replace(
      /[*+-][ \t]+|\d+[.)][ \t]+/g,
      (m) => " ".repeat(m.length),
    );
    return clean + "\n" + closePrefix + openChar.repeat(openCount);
  }
  return clean;
}

function formatCodeSpan(str: string): string {
  const clean = sanitizeCodeSpanText(str);
  const matches = clean.match(/`+/g) || [];
  let maxTicks = 0;
  for (const m of matches) {
    if (m.length > maxTicks) maxTicks = m.length;
  }
  const delimiter = "`".repeat(maxTicks + 1);
  const needsPadding = clean.startsWith("`") || clean.endsWith("`") ||
    clean.startsWith(" ") || clean.endsWith(" ");
  return needsPadding
    ? `${delimiter} ${clean} ${delimiter}`
    : `${delimiter}${clean}${delimiter}`;
}

export function formatWorkPacketMarkdown(packet: WorkbenchWorkPacket): string {
  const rawTitle = (packet.title ?? "").slice(0, 256);
  const cleanTitle = sanitizeSingleLine(rawTitle);
  const safeTitle = sanitizeMarkdownHeading(
    cleanTitle.length > 0 ? cleanTitle : "Untitled Work Packet",
  );
  const safeSession = formatCodeSpan(packet.sessionId);
  const safePacketId = formatCodeSpan(packet.packetId);
  const safeDate = formatCodeSpan(packet.createdAt.split("T")[0]);
  const safeIssue = packet.issueId ? formatCodeSpan(packet.issueId) : "none";
  const safeWorkspace = packet.targetWorkspace
    ? formatCodeSpan(packet.targetWorkspace)
    : "(current workspace)";
  const safeExcerpt = closeDanglingFences(
    sanitizeMarkdownHeading(packet.sourceContext.excerpt),
  );
  const safeIntent = closeDanglingFences(
    sanitizeMarkdownHeading(packet.operatorIntent),
  );

  const lines: string[] = [
    `# Work Packet: ${safeTitle}`,
    "",
    `- **Packet ID:** ${safePacketId}`,
    `- **Date:** ${safeDate}`,
    `- **Session:** ${safeSession}`,
    `- **Related Issue:** ${safeIssue}`,
    `- **Target Workspace:** ${safeWorkspace}`,
    "",
    "## 1. Source Context",
    "",
    safeExcerpt,
    "",
  ];

  if (
    packet.sourceContext.contextSources &&
    packet.sourceContext.contextSources.length > 0
  ) {
    lines.push("### Context Files", "");
    for (const src of packet.sourceContext.contextSources) {
      const safePath = formatCodeSpan(src);
      lines.push(`- ${safePath}`);
    }
    lines.push("");
  }

  lines.push(
    "## 2. Operator Intent",
    "",
    safeIntent,
    "",
    "## 3. Proposed Acceptance Criteria",
    "",
  );

  for (const criterion of packet.proposedAcceptanceCriteria) {
    const safeCriterion = sanitizeCriterion(criterion);
    lines.push(`- [ ] ${safeCriterion}`);
  }

  lines.push(
    "",
    "## 4. Verification & Provenance",
    "",
    `- **Primary Verifier:** ${
      formatCodeSpan(packet.verifierProvenance.verifierType)
    }`,
    `- **Independence Notes:** ${
      sanitizeSingleLine(packet.verifierProvenance.independenceNotes)
    }`,
    "",
  );

  return lines.join("\n");
}
