/** Whether an absolute POSIX path contains a whole `.` or `..` component. */
export function hasDotPathComponent(path: string): boolean {
  return /\/(?:\.|\.\.)(?:\/|$)/u.test(path);
}

/**
 * An error's message with host-path fragments replaced (BIT-826): a reason a
 * model, an operator and the durable log may all read. Best effort: runs of
 * non-whitespace that look like an absolute POSIX path, a Windows drive path
 * or a UNC share become `<path>`, so a path containing a space can leave its
 * tail behind. The message is cut to a bounded prefix before any replacement,
 * and the result is capped at `maxLength` characters.
 */
export function pathFreeReason(error: unknown, maxLength = 300): string {
  const message = error instanceof Error ? error.message : String(error);
  // Bounded before the replacements, so a huge message costs no more than the
  // prefix; a path cut at the boundary is still replaced as a fragment.
  return message
    .slice(0, maxLength * 4)
    .replace(/\/(?:[^\s'"`,;:]+\/?)+/gu, "<path>")
    .replace(/[A-Za-z]:\\[^\s'"`,;]*/gu, "<path>")
    .replace(/\\\\[^\s'"`,;]*/gu, "<path>")
    .slice(0, maxLength);
}
