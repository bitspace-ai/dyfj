import { isAbsolute } from "node:path";

export const DENO_EXECUTABLE_DIAGNOSTIC =
  "dyfj test gate: selected Deno executable is unavailable or unsafe";

export function validateDenoExecutable(executable: string): string {
  if (
    !isAbsolute(executable) ||
    executable.includes(",") ||
    executable.includes("\n") ||
    executable.includes("\r")
  ) {
    throw new Error(DENO_EXECUTABLE_DIAGNOSTIC);
  }
  return executable;
}

export function selectedDenoExecutable(
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  return validateDenoExecutable(read("DENO_BIN") ?? Deno.execPath());
}

export function resolveDenoExecutable(
  current: string,
  inherited?: string,
): string {
  const executable = validateDenoExecutable(current);
  if (inherited !== undefined && inherited !== "") {
    if (validateDenoExecutable(inherited) !== executable) {
      throw new Error(DENO_EXECUTABLE_DIAGNOSTIC);
    }
  }
  return executable;
}

if (import.meta.main) {
  try {
    console.log(resolveDenoExecutable(Deno.execPath(), Deno.args[0]));
  } catch {
    console.error(DENO_EXECUTABLE_DIAGNOSTIC);
    Deno.exit(64);
  }
}
