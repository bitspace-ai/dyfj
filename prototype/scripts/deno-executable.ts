import { isAbsolute } from "node:path";
import process from "node:process";

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

/**
 * The selected executable for a script that runs on Node, which has no
 * running executable of this kind to fall back on: DENO_BIN, required and
 * validated.
 */
export function requiredDenoExecutable(
  read: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const executable = read("DENO_BIN");
  if (executable === undefined || executable === "") {
    throw new Error(DENO_EXECUTABLE_DIAGNOSTIC);
  }
  return validateDenoExecutable(executable);
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
