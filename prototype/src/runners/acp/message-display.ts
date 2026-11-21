export function acpMessageSeparator(
  previousMessageId: unknown,
  messageId: unknown,
  previousTextEnding: string | undefined,
): string {
  if (previousTextEnding === undefined || previousMessageId === messageId) return "";
  if (previousTextEnding.endsWith("\n\n")) return "";
  return previousTextEnding.endsWith("\n") ? "\n" : "\n\n";
}

function textFromUpdate(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== "agent_message_chunk") return null;
  const content = update.content;
  if (typeof content !== "object" || content === null) return null;
  const block = content as Record<string, unknown>;
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : null;
}

/** One prompt's display stream; the returned text stays verbatim for recording. */
export function acpTextDisplay(onTextDelta?: (text: string) => void) {
  let previousMessageId: unknown;
  let previousTextEnding: string | undefined;
  return (update: Record<string, unknown>): string | null => {
    const delta = textFromUpdate(update);
    if (delta === null) return null;
    const separator = acpMessageSeparator(
      previousMessageId, update.messageId, previousTextEnding,
    );
    if (separator !== "") onTextDelta?.(separator);
    onTextDelta?.(delta);
    previousMessageId = update.messageId;
    previousTextEnding = ((previousTextEnding ?? "") + separator + delta).slice(-2);
    return delta;
  };
}
