import { resolveEsbuildBinary } from "./esbuild-binary.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import { fileURLToPath } from "node:url";

const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const esbuildBinary = await resolveEsbuildBinary(prototypeRoot);
const denoExecutable = selectedDenoExecutable();
const child = new Deno.Command(denoExecutable, {
  args: [
    "run",
    "-P=test",
    "--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders",
    "--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders",
    `--allow-run=bash,/bin/bash,${denoExecutable},/bin/kill,/bin/sh,${esbuildBinary}`,
    "npm:vitest@3.2.6",
    ...Deno.args,
  ],
  cwd: prototypeRoot,
  env: {
    ...Deno.env.toObject(),
    ESBUILD_BINARY_PATH: `${prototypeRoot}/${esbuildBinary}`,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const forwardSignal = (signal: Deno.Signal) => {
  try {
    child.kill(signal);
  } catch {
    // The child exited while the signal was being delivered.
  }
};
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
Deno.addSignalListener("SIGINT", onSigint);
Deno.addSignalListener("SIGTERM", onSigterm);

let exitCode = 1;
try {
  exitCode = (await child.status).code;
} finally {
  Deno.removeSignalListener("SIGINT", onSigint);
  Deno.removeSignalListener("SIGTERM", onSigterm);
}
Deno.exit(exitCode);
