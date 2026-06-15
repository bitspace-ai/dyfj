import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  executeListFiles,
  executeReadFile,
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
    expect(() => resolveWorkspacePath("/work", "/etc/hosts")).toThrow("escapes");
  });
  test("rejects sneaky traversal that climbs out", () => {
    expect(() => resolveWorkspacePath("/work", "a/../../etc")).toThrow("escapes");
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
    expect(await executeReadFile(root, "sub/nested.txt")).toBe("nested content");
  });
  test("returns an error for a traversal attempt (no read happens)", async () => {
    expect(await executeReadFile(root, "../../../etc/hosts")).toMatch(
      /^error: path escapes/,
    );
  });
  test("returns an error for a missing file", async () => {
    expect(await executeReadFile(root, "nope.txt")).toMatch(/^error: cannot read/);
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
