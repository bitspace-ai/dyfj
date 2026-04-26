#!/usr/bin/env bun
// Sync PAI memory markdown files into Rook's Dolt `memories` table.
//
// Source:  ~/.claude/projects/-Users-chris--claude/memory/*.md (top-level only)
// Target:  dolt.memories  (matched on UNIQUE slug)
// Skips:   MEMORY.md (index, not a memory)
//          MEMORY/WORK/** (PRDs / pickup-state, different artifact class)
//          originSessionId frontmatter (no schema column)
//
// Default: dry-run. Pass --commit to actually upsert.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import mysql from "mysql2/promise";
import { ulid } from "ulid";

const MEMORY_DIR = join(homedir(), ".claude/projects/-Users-chris--claude/memory");
const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

type MemoryType = "user" | "feedback" | "project" | "reference";

interface ParsedFile {
  slug:        string;
  name:        string;
  description: string;
  type:        MemoryType;
  content:     string;
  path:        string;
}

interface DoltRow {
  memory_id:   string;
  slug:        string;
  type:        string;
  name:        string;
  description: string;
  content:     string;
}

interface Plan {
  inserts:   ParsedFile[];
  updates:   { file: ParsedFile; existing: DoltRow; fieldsChanged: string[] }[];
  unchanged: ParsedFile[];
  invalid:   { path: string; reason: string }[];
  orphans:   DoltRow[];
}

// ── Frontmatter parsing ──────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
  const rest = raw.replace(/^---\r?\n/, "");
  const end = rest.search(/\r?\n---\r?\n/);
  if (end === -1) return null;
  const fmBlock = rest.slice(0, end);
  const body = rest.slice(end).replace(/^\r?\n---\r?\n/, "");
  const fields: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fields[key] = val;
  }
  return { fields, body };
}

async function loadFiles(): Promise<{ files: ParsedFile[]; invalid: { path: string; reason: string }[] }> {
  const entries = await readdir(MEMORY_DIR, { withFileTypes: true });
  const files: ParsedFile[] = [];
  const invalid: { path: string; reason: string }[] = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "MEMORY.md") continue;

    const path = join(MEMORY_DIR, e.name);
    const raw = await readFile(path, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      invalid.push({ path, reason: "no frontmatter block" });
      continue;
    }
    const { fields, body } = parsed;
    const missing = ["name", "description", "type"].filter(k => !fields[k]);
    if (missing.length) {
      invalid.push({ path, reason: `missing field(s): ${missing.join(", ")}` });
      continue;
    }
    if (!VALID_TYPES.has(fields.type!)) {
      invalid.push({ path, reason: `invalid type: ${fields.type}` });
      continue;
    }
    files.push({
      slug:        e.name.replace(/\.md$/, ""),
      name:        fields.name!,
      description: fields.description!,
      type:        fields.type as MemoryType,
      content:     body.trim(),
      path,
    });
  }
  return { files, invalid };
}

// ── Diff planning ────────────────────────────────────────────────────────────

function buildPlan(files: ParsedFile[], existing: DoltRow[], invalid: Plan["invalid"]): Plan {
  const existingBySlug = new Map(existing.map(r => [r.slug, r]));
  const inserts: ParsedFile[] = [];
  const updates: Plan["updates"] = [];
  const unchanged: ParsedFile[] = [];
  const fileSlugs = new Set<string>();

  for (const f of files) {
    fileSlugs.add(f.slug);
    const cur = existingBySlug.get(f.slug);
    if (!cur) {
      inserts.push(f);
      continue;
    }
    const fieldsChanged: string[] = [];
    if (cur.name        !== f.name)        fieldsChanged.push("name");
    if (cur.description !== f.description) fieldsChanged.push("description");
    if (cur.type        !== f.type)        fieldsChanged.push("type");
    if (cur.content     !== f.content)     fieldsChanged.push("content");
    if (fieldsChanged.length) updates.push({ file: f, existing: cur, fieldsChanged });
    else unchanged.push(f);
  }

  const orphans = existing.filter(r => !fileSlugs.has(r.slug));
  return { inserts, updates, unchanged, invalid, orphans };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function report(plan: Plan, commit: boolean): void {
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`\n[sync-memories — ${mode}]`);
  console.log(`  inserts:   ${plan.inserts.length}`);
  console.log(`  updates:   ${plan.updates.length}`);
  console.log(`  unchanged: ${plan.unchanged.length}`);
  console.log(`  invalid:   ${plan.invalid.length}`);
  console.log(`  orphans:   ${plan.orphans.length}  (in Dolt, no file on disk — NOT deleted)`);

  if (plan.inserts.length) {
    console.log("\n  NEW:");
    for (const f of plan.inserts) console.log(`    + ${f.slug.padEnd(40)} (${f.type})`);
  }
  if (plan.updates.length) {
    console.log("\n  CHANGED:");
    for (const u of plan.updates) {
      console.log(`    ~ ${u.file.slug.padEnd(40)} fields: ${u.fieldsChanged.join(", ")}`);
    }
  }
  if (plan.invalid.length) {
    console.log("\n  INVALID (skipped):");
    for (const i of plan.invalid) console.log(`    ! ${i.path}  -- ${i.reason}`);
  }
  if (plan.orphans.length) {
    console.log("\n  ORPHANS (in Dolt, missing on disk):");
    for (const o of plan.orphans) console.log(`    ? ${o.slug.padEnd(40)} (${o.type})`);
  }
}

// ── Apply (transactional UPSERT) ─────────────────────────────────────────────

async function apply(conn: mysql.Connection, plan: Plan): Promise<void> {
  if (!plan.inserts.length && !plan.updates.length) {
    console.log("\nNothing to write.");
    return;
  }
  await conn.beginTransaction();
  try {
    for (const f of plan.inserts) {
      await conn.execute(
        `INSERT INTO memories (memory_id, slug, type, name, description, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ulid(), f.slug, f.type, f.name, f.description, f.content],
      );
    }
    for (const u of plan.updates) {
      await conn.execute(
        `UPDATE memories
            SET type = ?, name = ?, description = ?, content = ?
          WHERE slug = ?`,
        [u.file.type, u.file.name, u.file.description, u.file.content, u.file.slug],
      );
    }
    await conn.commit();
    console.log(`\nWrote ${plan.inserts.length} insert(s), ${plan.updates.length} update(s).`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");

  const { files, invalid } = await loadFiles();

  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "dolt",
    database: "dolt",
  });

  try {
    const [rows] = await conn.execute(
      `SELECT memory_id, slug, type, name, description, content FROM memories`,
    );
    const existing = rows as DoltRow[];
    const plan = buildPlan(files, existing, invalid);
    report(plan, commit);
    if (commit) await apply(conn, plan);
    else console.log("\n(dry-run — pass --commit to apply)");
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
