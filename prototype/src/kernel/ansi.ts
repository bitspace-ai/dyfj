// deno-lint-ignore-file no-control-regex -- matching ESC is the point.
/** Terminal escape-sequence removal. */

/**
 * Remove complete terminal escape sequences from `text`: CSI (`ESC [`), OSC
 * terminated by BEL or ST (`ESC ]`), character-set designations (`ESC (` and
 * friends), and two-byte `ESC` Fe sequences, in that order. Only the 7-bit ESC
 * introducer is recognized: an unterminated OSC loses just its `ESC ]` to the
 * two-byte pass, and a trailing bare ESC or an 8-bit C1 introducer is left for
 * the caller's own control-character pass.
 */
export function stripAnsiEscapes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()*+-./][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}
