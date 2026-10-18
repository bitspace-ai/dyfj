/**
 * Fixed shapes for values that look like live credentials. Each is a literal
 * prefix or keyword followed by a bounded character class, so matching is
 * linear and cannot backtrack on hostile input.
 */
const SENSITIVE_SHAPES: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,256}/,
  /gh[pousr]_[A-Za-z0-9]{20,255}/,
  /github_pat_[A-Za-z0-9_]{20,255}/i,
  /xox[abposr]-[A-Za-z0-9-]{10,256}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/i,
  /\bbearer[\t \r\n]+[A-Za-z0-9._~+/-]{20,512}/i,
  /(?:^|[\s{,;:\[])["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?(?:key|token)|aws[_-]?secret[_-]?access[_-]?key|secret|token|pass(?:wor)?d|credential)["']?[\t \r\n]{0,8}[:=][\t \r\n]{0,8}["']?[^\s"']{8,512}/im,
];

export const SENSITIVE_PLACEHOLDER = "[scrubbed]";

/** Whether `value` carries something shaped like a live credential. */
export function containsSensitiveShape(value: string): boolean {
  return SENSITIVE_SHAPES.some((shape) => shape.test(value));
}

/** `value` with every credential-shaped substring replaced by `[scrubbed]`. */
export function scrubSensitiveShapes(value: string): string {
  let scrubbed = value;
  for (const shape of SENSITIVE_SHAPES) {
    const global = new RegExp(shape.source, `${shape.flags}g`);
    scrubbed = scrubbed.replace(global, SENSITIVE_PLACEHOLDER);
  }
  return scrubbed;
}
