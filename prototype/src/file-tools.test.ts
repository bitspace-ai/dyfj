import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  executeEditFile,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
  isWithinRoot,
  resolveWorkspacePath,
} from "./file-tools";

// ── resolveWorkspacePath (pure containment) ───────────────────────────────────

describe("resolveWorkspacePath", () => {
  test("resolves a path within the root", () => {
    expect(resolveWorkspacePath("/work", "src/a.ts")).toBe("/work/src/a.ts");
  });
  test("resolves the root itself for '.'", () => {
    expect(resolveWorkspacePath("/work", ".")).toBe("/work");
  });
  test("rejects parent traversal", () => {
    expect(() => resolveWorkspacePath("/work", "../secret")).toThrow("escapes");
  });
  test("rejects an absolute path outside the root", () => {
    expect(() => resolveWorkspacePath("/work", "/etc/hosts")).toThrow(
      "escapes",
    );
  });
  test("rejects sneaky traversal that climbs out", () => {
    expect(() => resolveWorkspacePath("/work", "a/../../etc")).toThrow(
      "escapes",
    );
  });
});

// ── isWithinRoot (canonical containment behind the symlink defense) ───────────

describe("isWithinRoot", () => {
  test("accepts a target nested under the root", () => {
    expect(isWithinRoot("/work", "/work/sub/a.txt")).toBe(true);
  });
  test("accepts the root itself", () => {
    expect(isWithinRoot("/work", "/work")).toBe(true);
  });
  test("rejects a sibling outside the root (symlink-escape shape)", () => {
    expect(isWithinRoot("/work", "/outside/secret.txt")).toBe(false);
  });
  test("rejects the parent of the root", () => {
    expect(isWithinRoot("/work/proj", "/work")).toBe(false);
  });
});

// ── executeReadFile / executeListFiles (scoped I/O) ───────────────────────────

let root: string;

beforeAll(async () => {
  await Deno.mkdir(".vitest-tmp", { recursive: true });
  root = await Deno.makeTempDir({ dir: ".vitest-tmp" });
  await Deno.writeTextFile(`${root}/hello.txt`, "hello world");
  await Deno.mkdir(`${root}/sub`);
  await Deno.writeTextFile(`${root}/sub/nested.txt`, "nested content");
});

afterAll(async () => {
  if (root) await Deno.remove(root, { recursive: true });
});

describe("executeReadFile", () => {
  test("reads a file within the workspace", async () => {
    expect(await executeReadFile(root, "hello.txt")).toBe("hello world");
  });
  test("reads a nested file", async () => {
    expect(await executeReadFile(root, "sub/nested.txt")).toBe(
      "nested content",
    );
  });
  test("returns an error for a traversal attempt (no read happens)", async () => {
    expect(await executeReadFile(root, "../../../etc/hosts")).toMatch(
      /^error: path escapes/,
    );
  });
  test("returns an error for a missing file", async () => {
    expect(await executeReadFile(root, "nope.txt")).toMatch(
      /^error: cannot read/,
    );
  });
  test("returns an error when the path is a directory", async () => {
    expect(await executeReadFile(root, "sub")).toMatch(/is a directory/);
  });
  test("truncates oversized content at the byte cap", async () => {
    const out = await executeReadFile(root, "hello.txt", 5);
    expect(out).toContain("[truncated at 5 characters]");
    expect(out.startsWith("hello")).toBe(true);
  });
});

describe("executeListFiles", () => {
  test("lists directory entries, directories suffixed with /", async () => {
    const out = await executeListFiles(root, ".");
    expect(out).toContain("hello.txt");
    expect(out).toContain("sub/");
  });
  test("lists a subdirectory", async () => {
    expect(await executeListFiles(root, "sub")).toBe("nested.txt");
  });
  test("rejects a traversal attempt", async () => {
    expect(await executeListFiles(root, "..")).toMatch(/^error: path escapes/);
  });
});

describe("executeWriteFile", () => {
  test("writes a new file within the workspace", async () => {
    const out = await executeWriteFile(root, "written.txt", "fresh content");
    expect(out).toBe("wrote written.txt");
    expect(await Deno.readTextFile(`${root}/written.txt`)).toBe(
      "fresh content",
    );
  });
  test("overwrites an existing file", async () => {
    await executeWriteFile(root, "over.txt", "first");
    await executeWriteFile(root, "over.txt", "second");
    expect(await Deno.readTextFile(`${root}/over.txt`)).toBe("second");
  });
  test("writes into an existing subdirectory", async () => {
    await executeWriteFile(root, "sub/new.txt", "in sub");
    expect(await Deno.readTextFile(`${root}/sub/new.txt`)).toBe("in sub");
  });
  test("rejects a traversal escape (no write happens)", async () => {
    expect(await executeWriteFile(root, "../escape.txt", "nope")).toMatch(
      /^error: path escapes/,
    );
  });
  test("errors when the parent directory does not exist", async () => {
    expect(await executeWriteFile(root, "missing/deep.txt", "x")).toMatch(
      /^error: cannot write/,
    );
  });
  test("the success result carries no payload length (no size signal)", async () => {
    expect(await executeWriteFile(root, "sized.txt", "0123456789")).toBe(
      "wrote sized.txt",
    );
  });
});

describe("executeWriteFile symlink containment", () => {
  // The scoped test sandbox forbids Deno.symlink (a symlink's target cannot be
  // permission-scoped), so the no-follow guard is exercised with an injected
  // lstat. The real OS symlink-follow escape — a dangling in-root link to an
  // outside target — is validated separately by the Codex security PoC.
  test("refuses to write when the target is a symlink, and writes nothing", async () => {
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeWriteFile(
      root,
      "link.txt",
      "escaped",
      fakeSymlinkLstat,
    );
    expect(out).toMatch(/refusing to write through a symlink/);
    // The guard runs before the write, so nothing is created.
    await expect(Deno.stat(`${root}/link.txt`)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
  });
});

describe("executeEditFile", () => {
  test("replaces a unique fragment and reports the edit", async () => {
    await executeWriteFile(root, "edit-basic.txt", "alpha beta gamma");
    const out = await executeEditFile(root, "edit-basic.txt", "beta", "DELTA");
    expect(out).toBe("edited edit-basic.txt");
    expect(await Deno.readTextFile(`${root}/edit-basic.txt`)).toBe(
      "alpha DELTA gamma",
    );
  });
  test("errors when the old text is absent (file unchanged)", async () => {
    await executeWriteFile(root, "edit-absent.txt", "unchanged");
    expect(await executeEditFile(root, "edit-absent.txt", "missing", "x"))
      .toMatch(/oldString not found/);
    expect(await Deno.readTextFile(`${root}/edit-absent.txt`)).toBe(
      "unchanged",
    );
  });
  test("errors when the old text is not unique (file unchanged)", async () => {
    await executeWriteFile(root, "edit-dup.txt", "x x x");
    expect(await executeEditFile(root, "edit-dup.txt", "x", "y")).toMatch(
      /not unique/,
    );
    expect(await Deno.readTextFile(`${root}/edit-dup.txt`)).toBe("x x x");
  });
  test("errors for a missing file (no create)", async () => {
    expect(await executeEditFile(root, "edit-nope.txt", "a", "b")).toMatch(
      /file not found/,
    );
  });
  test("rejects a traversal escape", async () => {
    expect(await executeEditFile(root, "../escape.txt", "a", "b")).toMatch(
      /^error: path escapes/,
    );
  });
  test("rejects an empty oldString", async () => {
    await executeWriteFile(root, "edit-empty.txt", "content");
    expect(await executeEditFile(root, "edit-empty.txt", "", "x")).toMatch(
      /oldString must be non-empty/,
    );
  });
  test("inherits the write-back symlink guard (refuses, writes nothing)", async () => {
    await executeWriteFile(root, "edit-link.txt", "before");
    const fakeSymlinkLstat = () => Promise.resolve({ isSymlink: true });
    const out = await executeEditFile(
      root,
      "edit-link.txt",
      "before",
      "after",
      fakeSymlinkLstat,
    );
    expect(out).toMatch(/refusing to write through a symlink/);
    expect(await Deno.readTextFile(`${root}/edit-link.txt`)).toBe("before");
  });
});
