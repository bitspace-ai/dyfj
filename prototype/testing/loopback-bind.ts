import { execFileSync } from "node:child_process";
import { bindOutcomeFromExit, type BindOutcome, inCi } from "./unix-socket-bind.ts";

// As with the Unix probe, a child owns the socket so the per-file handle
// check never observes a probe handle waiting for its close callback.
const PROGRAM = `
import { createServer } from "node:net";
const server = createServer();
server.once("error", (error) => {
  process.stdout.write(String(error.code ?? ""));
  process.exit(error.code === "EPERM" ? 10 : 11);
});
server.listen(0, "127.0.0.1", () => server.close(() => process.exit(0)));
`;

export function probeLoopbackBind(): BindOutcome {
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", PROGRAM], {
      env: {}, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
    });
    return { ok: true };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: Buffer | string };
    return bindOutcomeFromExit(failure.status ?? null, String(failure.stdout ?? ""));
  }
}

export function loopbackSkipReason(
  outcome: BindOutcome,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (outcome.ok || outcome.code !== "EPERM" || inCi(env)) return undefined;
  return "this process may not bind a loopback TCP port (EPERM, as inside a sandbox); " +
    "the test runs, and a refusal fails it, under CI";
}

export function loopbackBindSkip(): Promise<string | undefined> {
  return Promise.resolve(loopbackSkipReason(probeLoopbackBind(), process.env));
}
