/**
 * Operator global instructions loader (`[context] operator_instructions` /
 * `DYFJ_OPERATOR_INSTRUCTIONS`, BIT-981).
 *
 * Loads one operator-configured markdown file for native loopback companion
 * turns. Security invariants match `runners/acp/operator-context.ts` and
 * `loadAgentsInstructions`:
 *
 * - Symlinks along ancestor/parent directories (e.g. macOS `/var` ->
 *   `/private/var`) are resolved via `realpath(dirname(path))`, and the
 *   canonical parent directory must be an account-owned directory with no
 *   group or other write bits (`(mode & 0o022) === 0`) and verifiable
 *   `(dev, ino)` identity.
 * - The target leaf is checked with `lstat` (refusing symlinks, directories,
 *   FIFOs, or any non-regular file) and opened with `O_NOFOLLOW` where
 *   supported, then re-checked via `fstat` for matching `(dev, ino)`, regular
 *   file type, account ownership, and no shared write bits.
 * - The canonical parent directory's identity and permissions are re-verified
 *   after the read.
 * - Size is bounded both in raw bytes (`OPERATOR_INSTRUCTIONS_MAX_BYTES`,
 *   64 KiB) and in estimated tokens (`OPERATOR_INSTRUCTIONS_MAX_TOKENS`,
 *   16,000 tokens): oversized files are refused fail-closed rather than
 *   silently truncated so boundary rules near the end of an instruction file
 *   cannot be dropped unnoticed.
 * - Missing, unreadable, or refused files degrade safely to `null` with a
 *   path-free `console.warn` diagnostic so unrelated turns still run and raw
 *   host paths never leak into logs or model-visible text.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES } from "../config/mod.ts";
import { summarizeError } from "../contract/mod.ts";
import { hasVerifiableIdentity } from "../kernel/mod.ts";
import {
  type ContextSource,
  estimateContextTokens,
} from "./repo-context.ts";

/** Maximum file size in bytes (matches `runners/acp/operator-context.ts`). */
export const OPERATOR_INSTRUCTIONS_MAX_BYTES = 65_536;

/** Maximum estimated token budget (`len / 4` estimate, refused fail-closed). */
export const OPERATOR_INSTRUCTIONS_MAX_TOKENS = 16_000;

/** Path-free source identifier recorded in `contextSourceLines` and receipts. */
export const OPERATOR_INSTRUCTIONS_SOURCE_PATH =
  "config:context.operator_instructions";

export interface OperatorInstructions {
  body: string;
  bytes: number;
  source: ContextSource;
}

interface ParentAnchor {
  canonical: string;
  dev: number;
  ino: number;
}

interface LeafAnchor {
  dev: number;
  ino: number;
}

function ownedWithoutSharedWrite(info: { uid: number; mode: number }): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && info.uid === uid && (info.mode & 0o022) === 0;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (err as { code?: unknown }).code === "ENOENT";
}

function isSafeAbsoluteFilePath(raw: string): boolean {
  if (
    raw === "" ||
    Buffer.byteLength(raw, "utf8") > MAX_OPERATOR_INSTRUCTIONS_PATH_BYTES
  ) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return false;
  if (!path.isAbsolute(raw)) return false;
  if (raw.endsWith("/") || raw.endsWith("\\")) return false;
  if (raw.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  return path.basename(raw) !== "";
}

async function resolveTrustedParent(
  parentDir: string,
): Promise<ParentAnchor | null> {
  let canonical: string;
  try {
    canonical = await realpath(parentDir);
  } catch (err) {
    console.warn(
      `Operator instructions skipped: parent directory not resolvable: ${
        summarizeError(err)
      }`,
    );
    return null;
  }
  try {
    const stat = await lstat(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      console.warn(
        "Operator instructions skipped: parent directory is not a directory",
      );
      return null;
    }
    if (!hasVerifiableIdentity(stat)) {
      console.warn(
        "Operator instructions skipped: parent directory identity unavailable on this platform",
      );
      return null;
    }
    if (process.platform !== "win32" && !ownedWithoutSharedWrite(stat)) {
      console.warn(
        "Operator instructions skipped: parent directory must be owned by the current user without group or other write permissions",
      );
      return null;
    }
    return { canonical, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    console.warn(
      `Operator instructions skipped: parent directory check failed: ${
        summarizeError(err)
      }`,
    );
    return null;
  }
}

async function checkRegularLeaf(candidate: string): Promise<LeafAnchor | null> {
  try {
    const stat = await lstat(candidate);
    if (!stat.isFile()) {
      console.warn(
        "Operator instructions skipped: target is not a regular file",
      );
      return null;
    }
    if (process.platform !== "win32" && !ownedWithoutSharedWrite(stat)) {
      console.warn(
        "Operator instructions skipped: target must be owned by the current user without group or other write permissions",
      );
      return null;
    }
    if (!hasVerifiableIdentity(stat)) {
      console.warn(
        "Operator instructions skipped: file identity unavailable on this platform",
      );
      return null;
    }
    if (stat.size > OPERATOR_INSTRUCTIONS_MAX_BYTES) {
      console.warn(
        `Operator instructions skipped: file exceeds the ${OPERATOR_INSTRUCTIONS_MAX_BYTES}-byte limit`,
      );
      return null;
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch (err) {
    if (isNotFound(err)) {
      console.warn("Operator instructions skipped: configured file not found");
      return null;
    }
    console.warn(
      `Operator instructions skipped: file check failed: ${summarizeError(err)}`,
    );
    return null;
  }
}

async function readVerifiedFile(
  candidate: string,
  checked: LeafAnchor,
): Promise<Buffer | null> {
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const file = await open(candidate, flags);
    try {
      const opened = await file.stat();
      if (!opened.isFile()) {
        console.warn(
          "Operator instructions skipped: opened target is not a regular file",
        );
        return null;
      }
      if (process.platform !== "win32" && !ownedWithoutSharedWrite(opened)) {
        console.warn(
          "Operator instructions skipped: opened target permissions or ownership changed",
        );
        return null;
      }
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
        console.warn(
          "Operator instructions skipped: file identity changed between check and open",
        );
        return null;
      }
      if (opened.size > OPERATOR_INSTRUCTIONS_MAX_BYTES) {
        console.warn(
          `Operator instructions skipped: file exceeds the ${OPERATOR_INSTRUCTIONS_MAX_BYTES}-byte limit`,
        );
        return null;
      }
      const buffer = Buffer.alloc(OPERATOR_INSTRUCTIONS_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer.subarray(length));
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > OPERATOR_INSTRUCTIONS_MAX_BYTES) {
        console.warn(
          `Operator instructions skipped: file exceeds the ${OPERATOR_INSTRUCTIONS_MAX_BYTES}-byte limit`,
        );
        return null;
      }
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (err) {
    console.warn(
      `Operator instructions skipped: file read failed: ${summarizeError(err)}`,
    );
    return null;
  }
}

async function reverifyTrustedParent(parent: ParentAnchor): Promise<boolean> {
  try {
    const after = await lstat(parent.canonical);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== parent.dev ||
      after.ino !== parent.ino ||
      (process.platform !== "win32" && !ownedWithoutSharedWrite(after))
    ) {
      console.warn(
        "Operator instructions skipped: parent directory changed during read",
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `Operator instructions skipped: parent directory not re-verifiable: ${
        summarizeError(err)
      }`,
    );
    return false;
  }
}

/**
 * Load and validate the operator's global instructions file.
 * Returns `null` (with a path-free warning) when the file is absent,
 * unreadable, or fails any ownership, permission, type, TOCTOU, or size check.
 */
export async function loadOperatorInstructions(
  configuredPath: string,
): Promise<OperatorInstructions | null> {
  if (!isSafeAbsoluteFilePath(configuredPath)) {
    console.warn("Operator instructions skipped: invalid configured path");
    return null;
  }

  const parent = await resolveTrustedParent(path.dirname(configuredPath));
  if (parent === null) return null;

  const candidate = path.join(parent.canonical, path.basename(configuredPath));
  const checked = await checkRegularLeaf(candidate);
  if (checked === null) return null;

  const rawBytes = await readVerifiedFile(candidate, checked);
  if (rawBytes === null) return null;

  if (!(await reverifyTrustedParent(parent))) return null;

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    console.warn("Operator instructions skipped: file is not valid UTF-8");
    return null;
  }

  const body = decoded.trim();
  if (body === "") {
    console.warn("Operator instructions skipped: file is empty");
    return null;
  }
  if (estimateContextTokens(body) > OPERATOR_INSTRUCTIONS_MAX_TOKENS) {
    console.warn(
      `Operator instructions skipped: file exceeds the ${OPERATOR_INSTRUCTIONS_MAX_TOKENS}-token budget`,
    );
    return null;
  }

  return {
    body,
    bytes: rawBytes.byteLength,
    source: {
      kind: "file",
      label: "operator instructions",
      path: OPERATOR_INSTRUCTIONS_SOURCE_PATH,
    },
  };
}
