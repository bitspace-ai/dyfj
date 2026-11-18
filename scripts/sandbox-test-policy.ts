import { parse, type Comment } from "acorn";
import { stripTypes } from "./arch-imports-parse.ts";
import { readTrackedFile, readUntrackedFile, repoRootFromMeta, sanitizeForLog, trackedFiles, untrackedFiles } from "./scan-lib.ts";

// ESTree is read structurally, like the architecture parser.
type Node = any;
export interface SandboxTestHit { line: number; rule: "tmp" | "loopback" }

export function scanTest(source: string): SandboxTestHit[] {
  const comments: Comment[] = [];
  const tree = parse(stripTypes(source), {
    ecmaVersion: "latest", sourceType: "module", locations: true, onComment: comments,
  });
  const aliases = new Map<string, string>();
  const constants = new Map<string, Node>();
  const probes = new Set<string>();
  function walk(node: Node, visit: (node: Node) => void) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
      else if (value && typeof value === "object") walk(value, visit);
    }
  }
  walk(tree, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const spec of node.specifiers) {
        if (spec.type !== "ImportSpecifier") continue;
        aliases.set(spec.local.name, spec.imported.name);
        if (spec.imported.name === "loopbackBindSkip" &&
          /(?:^|\/)testing\/loopback-bind\.ts$/.test(node.source.value)) probes.add(spec.local.name);
      }
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      constants.set(node.id.name, node.init);
    }
  });
  function name(node: Node): string | undefined {
    if (node?.type === "Identifier") return aliases.get(node.name) ?? node.name;
    if (node?.type === "MemberExpression") {
      return node.computed ? node.property.value : node.property.name;
    }
    return undefined;
  }
  function contains(node: Node, match: (text: string) => boolean, seen = new Set<string>()): boolean {
    if (!node) return false;
    if (node.type === "Literal" && typeof node.value === "string") return match(node.value);
    if (node.type === "TemplateLiteral") return node.quasis.some((q: Node) => match(q.value.cooked ?? q.value.raw));
    if (node.type === "Identifier" && !seen.has(node.name)) {
      return contains(constants.get(node.name), match, new Set([...seen, node.name]));
    }
    let found = false;
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) found ||= value.some((n) => contains(n, match, seen));
      else if (value && typeof value === "object") found ||= contains(value, match, seen);
    }
    return found;
  }
  function guarded(node: Node): boolean {
    if (node.type !== "CallExpression" || !["test", "it", "describe"].includes(name(node.callee) ?? "")) return false;
    const options = node.arguments[1];
    if (options?.type !== "ObjectExpression") return false;
    return options.properties.some((p: Node) => {
      if ((p.key?.name ?? p.key?.value) !== "skip") return false;
      const call = p.value?.type === "AwaitExpression" ? p.value.argument : undefined;
      return call?.type === "CallExpression" && call.callee.type === "Identifier" && probes.has(call.callee.name);
    });
  }
  const hits: SandboxTestHit[] = [];
  function visit(node: Node, protectedBind = false) {
    if (!node || typeof node !== "object") return;
    const guardedHere = protectedBind || guarded(node);
    if (node.type === "CallExpression") {
      const method = name(node.callee);
      const line = node.loc.start.line;
      if (["mkdtemp", "mkdtempSync"].includes(method ?? "") &&
        contains(node.arguments[0], (s) => s === "/tmp" || s.startsWith("/tmp/"))) {
        const allowed = comments.some((c) => c.type === "Line" && c.loc?.end.line === line - 1 &&
          /^\s*sandbox-test-allow-tmp:\s*\S.+$/.test(c.value));
        if (!allowed) hits.push({ line, rule: "tmp" });
      }
      const first = node.arguments[0];
      const tcpPort = (first?.type === "Literal" && typeof first.value === "number") ||
        (first?.type === "ObjectExpression" && first.properties.some((p: Node) =>
          (p.key?.name ?? p.key?.value) === "port"));
      if (method === "listen" && !guardedHere && (tcpPort || node.arguments.slice(0, 2).some((arg: Node) =>
        contains(arg, (s) => /^127\./.test(s) || s === "localhost" || s === "::1")))) {
        hits.push({ line, rule: "loopback" });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, guardedHere));
      else if (value && typeof value === "object") visit(value, guardedHere);
    }
  }
  visit(tree);
  return hits;
}

export async function scanRepo(root: string): Promise<string[]> {
  const hits: string[] = [];
  const tracked = new Set(await trackedFiles(root, "sandbox-test policy"));
  const untracked = await untrackedFiles(root, "sandbox-test policy");
  if (untracked.truncated) hits.push("sandbox-test policy: untracked inventory limit exceeded");
  for (const path of new Set([...tracked, ...untracked.paths])) {
    if (!/\.test\.[cm]?[jt]s$/.test(path)) continue;
    const read = tracked.has(path)
      ? { bytes: await readTrackedFile(root, path, "sandbox-test policy"), truncated: false }
      : await readUntrackedFile(root, path, "sandbox-test policy");
    if (read.truncated) {
      hits.push(`${sanitizeForLog(path, 300)}: test exceeds scan limit`);
      continue;
    }
    const source = new TextDecoder().decode(read.bytes);
    try {
      for (const hit of scanTest(source)) {
        hits.push(`${sanitizeForLog(path, 300)}:${hit.line}: ${hit.rule}`);
      }
    } catch {
      hits.push(`${sanitizeForLog(path, 300)}: cannot parse test`);
    }
  }
  return hits;
}

if (import.meta.main) {
  const hits = await scanRepo(repoRootFromMeta());
  console.log(hits.length ? hits.slice(0, 100).join("\n") : "sandbox-test policy: clean");
  process.exitCode = hits.length ? 1 : 0;
}
