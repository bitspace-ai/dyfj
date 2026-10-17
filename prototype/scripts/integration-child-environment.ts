import process from "node:process";

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
  read: (name: string) => string | undefined = (name) => process.env[name],
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
