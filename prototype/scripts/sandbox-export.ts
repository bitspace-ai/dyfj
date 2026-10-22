/**
 * Export the isolated machine's workspace commits to the Mac as one mbox
 * (BIT-735). Run on the Mac:
 *
 *   node sandbox-export.ts (--base <rev> | --root) --out <file.mbox>
 *                          [--machine dyfj-l8] [--max-bytes <n>]
 *
 * The Mac starts the export and nothing on the Mac is mounted in the machine.
 * Inside the machine, `git format-patch` runs in a fresh executor sandbox: the
 * executor's uid, no network, and git's program-running config off (hooks,
 * fsmonitor, external diff, textconv, pager, system config), so a planted
 * repository setting cannot run a program while exporting. The Mac reads at
 * most `--max-bytes` (8 MiB by default), checks the output is a format-patch
 * mbox of UTF-8 text, and writes it to a new file. Apply it with `git am`.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import type { Readable } from "node:stream";

const SANDBOX = "/usr/libexec/dyfj/dyfj-sandbox";
const EXECUTOR_PLAN = "/etc/dyfj/l8/executor.plan.json";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A plain revision name with optional ancestry suffixes (`~N`, `^`): no
 * option, range, other revision operator or space.
 */
const BASE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*(?:~[0-9]+|\^)*$/;
const MACHINE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The command the Mac runs to read the commits since `base`, or every commit
 * when `base` is null.
 */
export function exportCommand(machine: string, base: string | null): string[] {
  if (!MACHINE.test(machine)) throw new Error("machine must be a plain name");
  if (base !== null && (!BASE.test(base) || base.includes(".."))) {
    throw new Error("base must be a plain revision name");
  }
  return [
    "orb",
    "-m",
    machine,
    "-u",
    "root",
    "env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "GIT_CONFIG_NOSYSTEM=1",
    SANDBOX,
    "run",
    "--plan",
    EXECUTOR_PLAN,
    "--cwd",
    "/work",
    "--",
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "format-patch",
    "--stdout",
    "--no-ext-diff",
    "--no-textconv",
    ...(base === null ? ["--root", "HEAD"] : [`${base}..HEAD`]),
    "--",
  ];
}

/**
 * The number of patches in the export. Checks that it is UTF-8 text with no
 * NUL, that it opens with a format-patch separator (`From <hash> `), and that
 * each separator is followed by its own `Subject:` header. It does not parse
 * the patches; `git am` does.
 */
export function checkMbox(output: Buffer): { patches: number } {
  if (output.length === 0) throw new Error("no commits since the base");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error("export is not text");
  }
  if (text.includes("\u0000")) throw new Error("export is not text");
  if (!/^From [0-9a-f]{7,64} /.test(text)) {
    throw new Error("export is not a format-patch mbox");
  }
  const patches = text.split(/^(?=From [0-9a-f]{7,64} )/m);
  if (!patches.every((patch) => /^Subject: /m.test(patch))) {
    throw new Error("export is not a format-patch mbox");
  }
  return { patches: patches.length };
}

/** `stream` in full, or a refusal once it passes `max` bytes. */
export function readBounded(stream: Readable, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        stream.destroy();
        reject(new Error(`export exceeds ${max} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** The value after `name`, or undefined when `name` is absent. */
export function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

/** Runs `command` and returns its checked output, within `max` bytes. */
export async function runExport(
  command: readonly string[],
  max: number,
): Promise<{ output: Buffer; patches: number }> {
  const [program, ...rest] = command;
  const child = spawn(program!, rest, { stdio: ["ignore", "pipe", "inherit"] });
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) =>
      reject(new Error(`cannot start the export command: ${error.message}`))
    );
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code))
  );
  await started;
  let output: Buffer;
  try {
    output = await readBounded(child.stdout, max);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`the export command exited ${code}`);
  return { output, ...checkMbox(output) };
}

async function main(args: readonly string[]) {
  const base = flag(args, "--base");
  const root = args.includes("--root");
  const out = flag(args, "--out");
  if ((base === undefined) === !root || out === undefined) {
    throw new Error("usage: sandbox-export.ts (--base <rev> | --root) --out <file.mbox>");
  }
  const machine = flag(args, "--machine") ?? "dyfj-l8";
  const max = Number(flag(args, "--max-bytes") ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error("--max-bytes must be a positive whole number");
  }
  const { output, patches } = await runExport(
    exportCommand(machine, base ?? null),
    max,
  );
  writeFileSync(out, output, { flag: "wx", mode: 0o644 });
  process.stdout.write(`wrote ${patches} patch(es), ${output.length} bytes, to ${out}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sandbox-export: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
