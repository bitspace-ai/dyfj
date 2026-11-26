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

/**
 * A block whose *first* invoke names a tool the caller did not offer and whose
 * second invoke the reply cuts off inside the invoke name, where the part that
 * arrived (`ba`) prefixes an offered tool (`bash`). Nothing here makes the block
 * recoverable: recovery runs a block only when every invoke names an offered
 * tool. The finish strip once read the truncated second name on its own and cut
 * the block, throwing `Provider stream presentation diverged` because the
 * presenter had already forwarded it.
 */
export const DSML_UNOFFERED_FIRST_TRUNCATED_SECOND_BLOCK =
  `${dsmlTag("spaced", "calls")}\n` +
  `${dsmlTag("spaced", "invoke", ' name="other"')}\n` +
  `${dsmlTag("spaced", "parameter", ' name="x" string="true"')}v` +
  `${dsmlCloseTag("spaced", "parameter")}\n` +
  `${dsmlCloseTag("spaced", "invoke")}\n` +
  // The invoke opening without its `>`: the reply ends inside the name.
  `${dsmlTag("spaced", "invoke", ' name="bash"').slice(0, -1)}`;

/**
 * A block the presenter withheld (its first invoke names the offered `bash`)
 * whose second invoke names a tool the caller did not offer, so recovery
 * declines the block and the text ends inside it. The block is never shown: the
 * presenter was still withholding it when the reply ended, and the finish strip
 * drops it.
 */
export const DSML_WITHHELD_UNOFFERED_SECOND_BLOCK =
  `${dsmlTag("spaced", "calls")}\n` +
  `${dsmlTag("spaced", "invoke", ' name="bash"')}\n` +
  `${dsmlTag("spaced", "parameter", ' name="command" string="true"')}echo hi` +
  `${dsmlCloseTag("spaced", "parameter")}\n` +
  `${dsmlCloseTag("spaced", "invoke")}\n` +
  `${dsmlTag("spaced", "invoke", ' name="other"')}\n` +
  `${dsmlTag("spaced", "parameter", ' name="x" string="true"')}v` +
  `${dsmlCloseTag("spaced", "parameter")}\n`;

/**
 * A Qwen `<tool_call>` block naming `bash`, as a model writes it in text.
 *
 * The separator-wrapped DSML tags are assembled by `dsmlTag`, so no fixture
 * holds a separator-wrapped `DSML` run as a literal in its source text.
 */
export function qwenBashBlock(command: string): string {
  return `<tool_call><function=bash><parameter=command>${command}` +
    `</parameter></function></tool_call>`;
}

/**
 * A truncated block whose first invoke names the offered `bash`, so a reader
 * withholds it, and whose `command` value holds a *complete* Qwen block. The
 * reply ends inside the DSML block with no closing tags, which is the shape a
 * model leaves when it writes a heredoc that embeds a Qwen fixture and then
 * stops.
 *
 * Recovery removes the Qwen block independently of the DSML dialect, so the
 * withheld span is shorter than the distance from its start to the end of the
 * reply. A strip that measured that distance against the text with complete
 * calls already removed cut into prose, or past the start of the string.
 */
export function dsmlTruncatedBlockWithNestedQwen(command: string): string {
  return `${dsmlTag("spaced", "calls")}\n` +
    `${dsmlTag("spaced", "invoke", ' name="bash"')}\n` +
    `${dsmlTag("spaced", "parameter", ' name="command" string="true"')}` +
    `cat > f <<X\n${qwenBashBlock(command)}\nmore`;
}

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
