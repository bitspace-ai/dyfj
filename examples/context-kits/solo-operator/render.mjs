import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitDir = dirname(fileURLToPath(import.meta.url));

const sections = [
  ["Identity", "identity.md"],
  ["Communication Style", "communication-style.md"],
  ["Active Work", "active-work.md"],
  ["Privacy Boundaries", "privacy-boundaries.md"],
];

const chunks = [
  "# Solo Operator Assistant Context",
  "",
  "Generated from `source/` by `render.mjs`.",
  "",
];

for (const [title, filename] of sections) {
  const source = await readFile(resolve(kitDir, "source", filename), "utf8");
  chunks.push(`## ${title}`, "", source.trim(), "");
}

const projection = `${chunks.join("\n").trimEnd()}\n`;
const outputPath = resolve(kitDir, "projections", "assistant-context.md");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, projection, "utf8");

console.log(`wrote ${outputPath}`);
