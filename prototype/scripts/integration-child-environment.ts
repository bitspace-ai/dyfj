const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CARGO_HOME",
  "RUSTUP_HOME",
];

export function integrationChildEnvironment(
  explicit: Record<string, string>,
  read: (name: string) => string | undefined = Deno.env.get,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      inheritedEnvironmentNames.flatMap((name) => {
        const value = read(name);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    ...explicit,
  };
}
