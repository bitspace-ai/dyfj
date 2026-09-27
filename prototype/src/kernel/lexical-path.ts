/** Whether an absolute POSIX path contains a whole `.` or `..` component. */
export function hasDotPathComponent(path: string): boolean {
  return /\/(?:\.|\.\.)(?:\/|$)/u.test(path);
}
