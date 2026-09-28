// Prints the `--allow-net` flag `deno task serve-unix` starts the engine with:
// the serve-unix profile's net list plus `<ip>:53` for each system nameserver,
// so the web tools' address check can resolve hostnames when the engine is
// started directly rather than through `dyfj start`. An explicit `--allow-net`
// replaces the profile's list, so the flag repeats it.
//
// Prints nothing when the profile's net list cannot be read or holds an entry
// a single flag cannot carry; the task then runs with the profile's own list.
import { readNameserverNetGrants } from "../src/config/mod.ts";

export async function serveUnixNetFlag(
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<string> {
  let profileNet: unknown;
  try {
    const parsed = JSON.parse(await readTextFile("deno.json")) as {
      permissions?: { "serve-unix"?: { net?: unknown } };
    };
    profileNet = parsed.permissions?.["serve-unix"]?.net;
  } catch {
    return "";
  }
  if (
    !Array.isArray(profileNet) || profileNet.length === 0 ||
    profileNet.some((grant) =>
      typeof grant !== "string" || grant === "" || /[,\s]/.test(grant)
    )
  ) {
    return "";
  }
  const grants = [...profileNet as string[]];
  for (const grant of await readNameserverNetGrants(readTextFile)) {
    if (!grants.includes(grant)) grants.push(grant);
  }
  return `--allow-net=${grants.join(",")}`;
}

if (import.meta.main) {
  console.log(await serveUnixNetFlag());
}
