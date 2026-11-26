/**
 * DeepSeek DSML text tool-call fixtures.
 *
 * DeepSeek models occasionally write their native tool-call markup into the
 * message content instead of a structured `tool_calls` array. Two replies were
 * captured live from DeepSeek V4.1 Flash 1017 via OpenRouter on 2026-11-24: one
 * naming `bash`, one naming `gate_wait` with a typed `wait_seconds`. The
 * captured tag opener used the fullwidth vertical bar (U+FF5C) and a space
 * after the separator, e.g. `<`, the separator, `DSML`, the separator, ` calls`,
 * `>`; a tighter spelling with no space, an ASCII-pipe spelling, and the
 * `function_calls` wrapper name are covered too, because upstream tokenizers
 * vary.
 *
 * The tags are assembled from parts, so a fixture never holds a
 * separator-wrapped `DSML` run as a single literal in its source text.
 */

/** Fullwidth vertical bar (U+FF5C), the separator in the captured replies. */
export const DSML_PIPE = "\uFF5C";

/** The separator spellings and gaps an upstream may emit. */
export type DsmlStyle = "spaced" | "tight" | "ascii";

/** The wrapper element names seen in the wild. */
export type DsmlWrapper = "calls" | "function_calls";

function separatorFor(style: DsmlStyle): string {
  return style === "ascii" ? "|" : DSML_PIPE;
}

function gapFor(style: DsmlStyle): string {
  return style === "spaced" ? " " : "";
}

/** A DSML tag opening: `<sep>DSML<sep> name="x">`. */
export function dsmlTag(
  style: DsmlStyle,
  name: string,
  attributes = "",
): string {
  const separator = separatorFor(style);
  return `<${separator}DSML${separator}${gapFor(style)}${name}${attributes}>`;
}

/** A DSML tag closing: `</<sep>DSML<sep> name>`. */
export function dsmlCloseTag(style: DsmlStyle, name: string): string {
  const separator = separatorFor(style);
  return `</${separator}DSML${separator}${gapFor(style)}${name}>`;
}

/** One `<parameter>` element: its name, its attribute suffix, its raw value. */
export type DsmlParameter = readonly [
  name: string,
  attributes: string,
  value: string,
];

/** One `<parameter>` element as the captured replies laid it out. */
export function dsmlParameter(
  style: DsmlStyle,
  [name, attributes, value]: DsmlParameter,
): string {
  return `${dsmlTag(style, "parameter", ` name="${name}"${attributes}`)}` +
    `${value}${dsmlCloseTag(style, "parameter")}`;
}

/**
 * A complete tool-call block: the wrapper around one `invoke` holding the given
 * parameters, one element per line as the captured replies were.
 */
export function dsmlBlock(
  style: DsmlStyle,
  invokeName: string,
  parameters: readonly DsmlParameter[],
  wrapper: DsmlWrapper = "calls",
): string {
  const body = parameters.map((parameter) => dsmlParameter(style, parameter))
    .join("\n");
  return `${dsmlTag(style, wrapper)}\n` +
    `${dsmlTag(style, "invoke", ` name="${invokeName}"`)}\n` +
    `${body}\n` +
    `${dsmlCloseTag(style, "invoke")}\n` +
    `${dsmlCloseTag(style, wrapper)}`;
}

/** An `invoke` opening with no close and no wrapper close: a cut-off block. */
export function dsmlPartialBlock(
  style: DsmlStyle,
  invokeName: string,
  parameters: readonly DsmlParameter[],
  wrapper: DsmlWrapper = "calls",
): string {
  const body = parameters.map((parameter) => dsmlParameter(style, parameter))
    .join("\n");
  return `${dsmlTag(style, wrapper)}\n` +
    `${dsmlTag(style, "invoke", ` name="${invokeName}"`)}\n` +
    body;
}

/** The command line of the captured `bash` reply. */
export const DSML_BASH_COMMAND =
  "cd prototype && node --test src/tools/builtin/git.test.ts 2>&1 | tail -12";

/** Captured live: a complete `bash` block in the spaced fullwidth spelling. */
export const DSML_BASH_BLOCK = dsmlBlock("spaced", "bash", [
  ["command", ' string="true"', DSML_BASH_COMMAND],
]);

/** The run id of the captured `gate_wait` reply. */
export const DSML_GATE_RUN = "6ba28af8-3951-4ac0-847a-00053408dcc2";

/**
 * Captured live: a complete `gate_wait` block whose first argument is a literal
 * string and whose second is JSON-typed (`string="false"`).
 */
export const DSML_GATE_WAIT_BLOCK = dsmlBlock("spaced", "gate_wait", [
  ["run", ' string="true"', DSML_GATE_RUN],
  ["wait_seconds", ' string="false"', "60"],
]);

/**
 * A complete block in the captured layout whose `parameter` carries no `name`
 * attribute, so the block names an offered tool but is not recoverable markup.
 */
export const DSML_INVALID_OFFERED_BLOCK = `${dsmlTag("spaced", "calls")}\n` +
  `${dsmlTag("spaced", "invoke", ' name="bash"')}\n` +
  `${dsmlTag("spaced", "parameter", ' string="true"')}${DSML_BASH_COMMAND}` +
  `${dsmlCloseTag("spaced", "parameter")}\n` +
  `${dsmlCloseTag("spaced", "invoke")}\n` +
  `${dsmlCloseTag("spaced", "calls")}`;

/** Prose to place before a block in a mixed reply. */
export const DSML_PROSE = "Let me check that.";

/**
 * The captured block cut into one-character chunks, so every DSML tag arrives
 * split across deltas: `forever`-sized pieces would hide the token-split
 * opener a real tokenizer produces.
 */
export function dsmlCharacterChunks(block: string): string[] {
  return [...block];
}

/** The captured block cut at each index in `cuts`, in order. */
export function dsmlChunksAt(block: string, cuts: readonly number[]): string[] {
  const chunks: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    chunks.push(block.slice(from, cut));
    from = cut;
  }
  chunks.push(block.slice(from));
  return chunks;
}
