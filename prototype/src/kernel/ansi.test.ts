import { assertEquals } from "@std/assert";
import { stripAnsiEscapes } from "./ansi.ts";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

Deno.test("stripAnsiEscapes removes CSI sequences", () => {
  assertEquals(stripAnsiEscapes(`${ESC}[31mred${ESC}[0m`), "red");
  assertEquals(stripAnsiEscapes(`a${ESC}[?25lb`), "ab");
});

Deno.test("stripAnsiEscapes removes OSC sequences ended by BEL or ST", () => {
  assertEquals(stripAnsiEscapes(`${ESC}]0;title${BEL}text`), "text");
  assertEquals(stripAnsiEscapes(`${ESC}]8;;https://x${ESC}\\link`), "link");
});

Deno.test("stripAnsiEscapes removes character-set and two-byte sequences", () => {
  assertEquals(stripAnsiEscapes(`${ESC}(Bplain`), "plain");
  assertEquals(stripAnsiEscapes(`${ESC}Mplain`), "plain");
});

Deno.test("stripAnsiEscapes leaves plain text alone", () => {
  assertEquals(stripAnsiEscapes("no escapes here"), "no escapes here");
});

Deno.test("stripAnsiEscapes drops only the introducer of an unterminated OSC", () => {
  // The two-byte pass consumes `ESC ]`; the payload stays as plain text.
  assertEquals(stripAnsiEscapes(`${ESC}]0;title`), "0;title");
});

Deno.test("stripAnsiEscapes leaves a bare ESC and 8-bit C1 introducers", () => {
  const CSI8 = String.fromCharCode(0x9b);
  assertEquals(stripAnsiEscapes(`a${ESC}`), `a${ESC}`);
  assertEquals(stripAnsiEscapes(`${CSI8}31m`), `${CSI8}31m`);
});
