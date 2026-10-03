/**
 * Direct document fetch for the web tools: a bounded GET of a checked public
 * URL, reduced to readable text.
 */

import { CommandExecutionError } from "../definition.ts";
import { boundedMcpFetch } from "../mcp/transport.ts";
import { type DnsResolver, systemDnsResolver } from "./dns.ts";
import {
  FETCH_TIMEOUT_MS,
  MAX_EXTRACTED_CHARS_PER_FETCH,
  MAX_FETCH_DOWNLOAD_BYTES,
} from "./web-limits.ts";
import {
  assertPublicDnsResolution,
  assertPublicHttpsUrl,
} from "./web-url-safety.ts";

const NAMED_HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&bull;": "•",
  "&cent;": "¢",
  "&pound;": "£",
  "&yen;": "¥",
  "&euro;": "€",
};

/** Decode common HTML entities into plain text. */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|copy|reg|trade|ndash|mdash|hellip|ldquo|rdquo|lsquo|rsquo|bull|cent|pound|yen|euro);|&#39;/gi,
      (entity) => {
        const lower = entity.toLowerCase();
        return NAMED_HTML_ENTITIES[lower] ?? entity;
      },
    )
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    });
}

function stripHtmlTags(str: string): string {
  let prev = str;
  while (true) {
    const stripped = prev.replace(/<[^>]*>/g, "");
    if (stripped === prev) return stripped;
    prev = stripped;
  }
}

/** Convert raw HTML content into Markdown-formatted text. */
export function extractReadableContentFromHtml(html: string): string {
  let text = html;

  // Remove scripts, styles, metadata, and non-content tags
  text = text.replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, " ");
  text = text.replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, " ");
  text = text.replace(/<noscript\b[\s\S]*?<\/noscript[^>]*>/gi, " ");
  text = text.replace(/<svg\b[\s\S]*?<\/svg[^>]*>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Remove navigation, headers, footers, forms, aside
  text = text.replace(/<header\b[\s\S]*?<\/header[^>]*>/gi, " ");
  text = text.replace(/<footer\b[\s\S]*?<\/footer[^>]*>/gi, " ");
  text = text.replace(/<nav\b[\s\S]*?<\/nav[^>]*>/gi, " ");
  text = text.replace(/<aside\b[\s\S]*?<\/aside[^>]*>/gi, " ");
  text = text.replace(/<form\b[\s\S]*?<\/form[^>]*>/gi, " ");

  // Convert headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1[^>]*>/gi, "\n\n# $1\n\n");
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2[^>]*>/gi, "\n\n## $1\n\n");
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3[^>]*>/gi, "\n\n### $1\n\n");
  text = text.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4[^>]*>/gi, "\n\n#### $1\n\n");
  text = text.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5[^>]*>/gi, "\n\n##### $1\n\n");
  text = text.replace(
    /<h6\b[^>]*>([\s\S]*?)<\/h6[^>]*>/gi,
    "\n\n###### $1\n\n",
  );

  // Convert links: <a href="url">text</a> -> [text](url)
  text = text.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a[^>]*>/gi,
    (_, href, label) => {
      const cleanLabel = stripHtmlTags(label).trim();
      if (!cleanLabel) return "";
      return `[${cleanLabel}](${href})`;
    },
  );

  // Convert lists
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li[^>]*>/gi, "\n- $1");

  // Paragraphs & line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p[^>]*>/gi, "\n\n");
  text = text.replace(/<p\b[^>]*>/gi, "\n\n");
  text = text.replace(/<div\b[^>]*>/gi, "\n");
  text = text.replace(/<\/div[^>]*>/gi, "\n");

  // Strip remaining HTML tags
  text = stripHtmlTags(text);

  // Decode entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Execute a bounded HTTP GET with redirect rejection, size cap, and an abortable timeout
 * covering DNS preflight, header arrival, and response body consumption.
 */
export async function safeFetchDocument(
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
  allowLoopbackHttpForTesting = false,
  resolver: DnsResolver = systemDnsResolver,
): Promise<{ text: string; url: string; contentType: string; bytes: number }> {
  const url = assertPublicHttpsUrl(targetUrl, allowLoopbackHttpForTesting);

  const boundedFetch = boundedMcpFetch(MAX_FETCH_DOWNLOAD_BYTES, fetchImpl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    await assertPublicDnsResolution(
      url.hostname,
      allowLoopbackHttpForTesting,
      controller.signal,
      resolver,
    );

    let response: Response;
    try {
      response = await boundedFetch(url.toString(), {
        redirect: "error",
        signal: controller.signal,
        headers: {
          "User-Agent": "DYFJ-Workbench-WebFetch/1.0",
          "Accept":
            "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1",
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CommandExecutionError(
          `Web fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
        );
      }
      throw new CommandExecutionError(
        `Web fetch request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CommandExecutionError(
        `Web fetch failed with HTTP status ${response.status} (${response.statusText})`,
      );
    }

    const rawContentType = response.headers.get("content-type") ?? "text/plain";
    const contentType = rawContentType.split(";")[0].trim().toLowerCase();

    const allowedTypes = new Set([
      "text/html",
      "text/plain",
      "text/markdown",
      "text/xml",
      "application/json",
      "application/xml",
    ]);

    if (!allowedTypes.has(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new CommandExecutionError(
        `Unsupported content type '${contentType}'. Only HTML, Markdown, text, XML, and JSON are supported.`,
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CommandExecutionError(
          `Web fetch timed out after ${
            FETCH_TIMEOUT_MS / 1000
          }s while reading body`,
        );
      }
      throw new CommandExecutionError(
        `Failed reading web response body: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const bytes = new TextEncoder().encode(bodyText).byteLength;
    let extracted: string;
    if (contentType === "text/html") {
      extracted = extractReadableContentFromHtml(bodyText);
    } else {
      extracted = bodyText.trim();
    }

    if (extracted.length > MAX_EXTRACTED_CHARS_PER_FETCH) {
      const marker =
        `\n\n[Content truncated at ${MAX_EXTRACTED_CHARS_PER_FETCH.toLocaleString()} characters]`;
      const keepChars = Math.max(
        0,
        MAX_EXTRACTED_CHARS_PER_FETCH - marker.length,
      );
      extracted = extracted.slice(0, keepChars) + marker;
    }

    return {
      text: extracted,
      url: url.toString(),
      contentType,
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}
