import {
  formatHits,
  isAllowedEmailDomain,
  parseScanArguments,
  permittedEnvReader,
  RULES,
  rulesForFamily,
  runTreeScan,
  scanText,
  scanTree,
} from "./public-safety-scan.ts";
import {
  MAX_REPORTED_HITS,
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_FILES,
  readTrackedFile,
  readUntrackedFile,
  untrackedFiles,
} from "./scan-lib.ts";
import { isWorktreeClean } from "./subject-check.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to include ${expected}`,
    );
  }
}

function captureOut(): {
  out: Pick<Console, "log" | "error">;
  text: () => string;
} {
  const lines: string[] = [];
  const record = (...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  };
  return { out: { log: record, error: record }, text: () => lines.join("\n") };
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    if (!String(error).includes(expected)) {
      throw new Error(`Expected ${String(error)} to include ${expected}`);
    }
    return;
  }
  throw new Error(`Expected function to throw ${expected}`);
}

// Fixtures are assembled at runtime so no rule-matching literal sits in
// tracked source: there is no allowlist and no path exemption, so this test
// file is scanned like any other public artifact.
function awsKeyFixture(): string {
  return ["AKIA", "EXAMPLE0", "12345678"].join("");
}

function homePathFixture(): string {
  return ["", "Users", "someone", "projects", "private"].join("/");
}

Deno.test("private-key headers fail", () => {
  const header = ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" ");
  const hits = scanText("docs/example.md", `${header}\n`);
  assertEquals(hits, [
    { path: "docs/example.md", line: 1, rule: "secret.tree/private-key" },
  ]);
});

Deno.test("well-known credential prefixes fail", () => {
  const fixtures: Array<[string, string]> = [
    [awsKeyFixture(), "secret.tree/aws-access-key-id"],
    [["ghp_", "a".repeat(36)].join(""), "secret.tree/github-token"],
    [["AIza", "B".repeat(35)].join(""), "secret.tree/google-api-key"],
    [["xoxb-", "1234567890-abc"].join(""), "secret.tree/slack-token"],
    [
      ["sk-ant-", "api03-", "x".repeat(16)].join(""),
      "secret.tree/anthropic-api-key",
    ],
    [
      ["eyJ", "a".repeat(10), ".", "eyJ", "b".repeat(10)].join(""),
      "secret.tree/jwt",
    ],
  ];
  for (const [value, rule] of fixtures) {
    const hits = scanText("docs/example.md", `token: ${value}\n`);
    assertEquals(hits.map((hit) => hit.rule), [rule]);
  }
});

Deno.test("empty and placeholder credential shapes pass", () => {
  const content = [
    "ANTHROPIC_API_KEY=",
    'ANTHROPIC_API_KEY  = "op://<vault>/<item>/credential"',
    "DATABASE_URL=mysql://root:<your-local-dolt-password>@127.0.0.1:3306/dolt",
    "# XAI_API_KEY=",
  ].join("\n");
  assertEquals(scanText("prototype/.env.example", content), []);
});

Deno.test("documentation-reserved email domains pass", () => {
  const content = [
    "contact fixture@example.invalid for nothing",
    "user hunter@internal.example.com in a fixture",
    "recall fixture-pass@memory.example",
    "probe root@db.test",
  ].join("\n");
  assertEquals(scanText("docs/example.md", content), []);
});

Deno.test("a non-example email address fails as a boundary hit", () => {
  const address = ["operator", "@", "gmail", ".com"].join("");
  const hits = scanText("docs/example.md", `Written by ${address}.\n`);
  assertEquals(hits, [{
    path: "docs/example.md",
    line: 1,
    rule: "public.boundary/personal-email",
  }]);
});

Deno.test("an address at end of sentence still fails", () => {
  const address = ["operator", "@", "gmail", ".com"].join("");
  const hits = scanText("docs/example.md", `Mail ${address}. Thanks.\n`);
  assertEquals(hits.map((hit) => hit.rule), [
    "public.boundary/personal-email",
  ]);
});

Deno.test("package and version specifiers are not emails", () => {
  const content = [
    "npm:@agentclientprotocol/codex-acp@1.1.10",
    "esbuild@0.20.1 pinned",
    "mysql://root@127.0.0.1:3306/dolt",
  ].join("\n");
  assertEquals(scanText("prototype/deno.json", content), []);
});

Deno.test("allowed-domain classification covers only RFC-reserved shapes", () => {
  assertEquals(isAllowedEmailDomain("internal.example.com"), true);
  assertEquals(isAllowedEmailDomain("example.net"), true);
  assertEquals(isAllowedEmailDomain("sub.example.org"), true);
  assertEquals(isAllowedEmailDomain("db.test"), true);
  assertEquals(isAllowedEmailDomain("memory.example"), true);
  assertEquals(isAllowedEmailDomain("gmail.com"), false);
  assertEquals(isAllowedEmailDomain("examples.com"), false);
  // An interior `example` label never reserves a real deliverable domain.
  assertEquals(isAllowedEmailDomain("example.evil.com"), false);
  assertEquals(isAllowedEmailDomain("mail.example.attacker.net"), false);
  assertEquals(isAllowedEmailDomain("example.co.uk"), false);
});

Deno.test("an interior example label does not exempt a real address", () => {
  const address = ["operator", "@", "example.evil", ".com"].join("");
  const hits = scanText("docs/example.md", `Mail ${address}. Thanks.\n`);
  assertEquals(hits.map((hit) => hit.rule), [
    "public.boundary/personal-email",
  ]);
});

Deno.test("home-directory paths fail everywhere, test files included", () => {
  const line = `logs live in ${homePathFixture()}\n`;
  for (
    const path of [
      "docs/example.md",
      "prototype/src/cli.test.ts",
      "prototype/src/a.spec.tsx",
    ]
  ) {
    assertEquals(scanText(path, line).map((hit) => hit.rule), [
      "public.boundary/home-directory-path",
    ]);
  }
});

Deno.test("a secret shape in a test fixture still fails", () => {
  const hits = scanText(
    "prototype/src/cli.test.ts",
    `key ${awsKeyFixture()}\n`,
  );
  assertEquals(hits.map((hit) => hit.rule), [
    "secret.tree/aws-access-key-id",
  ]);
});

Deno.test("rule families partition the rule set", () => {
  const families = ["secret.tree", "public.boundary"];
  const selected = families.flatMap((family) => [...rulesForFamily(family)]);
  assertEquals(selected.length, RULES.length);
  for (const rule of rulesForFamily("secret.tree")) {
    if (!rule.id.startsWith("secret.tree/")) {
      throw new Error(`family selection leaked ${rule.id}`);
    }
  }
  assertThrows(() => rulesForFamily("nonsense"), "unknown rule family");
});

Deno.test("a family-filtered scan reports only that family", () => {
  const address = ["operator", "@", "gmail", ".com"].join("");
  const content = `key ${awsKeyFixture()} by ${address}\n`;
  const secret = scanText(
    "docs/example.md",
    content,
    Number.POSITIVE_INFINITY,
    rulesForFamily("secret.tree"),
  );
  assertEquals(secret.map((hit) => hit.rule), [
    "secret.tree/aws-access-key-id",
  ]);
  const boundary = scanText(
    "docs/example.md",
    content,
    Number.POSITIVE_INFINITY,
    rulesForFamily("public.boundary"),
  );
  assertEquals(boundary.map((hit) => hit.rule), [
    "public.boundary/personal-email",
  ]);
});

Deno.test("scan arguments select a family and fail closed otherwise", () => {
  assertEquals(parseScanArguments([]), {});
  assertEquals(parseScanArguments(["--family", "secret.tree"]), {
    family: "secret.tree",
  });
  assertThrows(
    () => parseScanArguments(["--family", "made.up"]),
    "unknown rule family",
  );
  assertThrows(() => parseScanArguments(["--all"]), "unknown arguments");
});

Deno.test("a secret shape in the scanner's own source still fails", () => {
  const hits = scanText(
    "scripts/public-safety-scan.ts",
    `key: ${awsKeyFixture()}\n`,
  );
  assertEquals(hits.map((hit) => hit.rule), [
    "secret.tree/aws-access-key-id",
  ]);
});

Deno.test("secret shapes inside binary-looking content are detected", () => {
  const value = awsKeyFixture();
  const hits = scanText("assets/blob.bin", `\0\x01${value}\0`);
  assertEquals(hits.map((hit) => hit.rule), [
    "secret.tree/aws-access-key-id",
  ]);
  // Detection is proven without echoing the payload: the formatted report
  // carries only path, line, and rule id.
  const formatted = formatHits(hits);
  if (formatted.includes(value)) {
    throw new Error("binary-payload content reached formatted output");
  }
  assertEquals(formatted, "assets/blob.bin:1: secret.tree/aws-access-key-id");
});

Deno.test("formatted output is value-free: matched content never appears", () => {
  const value = awsKeyFixture();
  const hits = scanText("docs/example.md", `key ${value}\n`);
  assertEquals(hits.length, 1);
  const formatted = formatHits(hits);
  if (formatted.includes(value)) {
    throw new Error("secret-shaped content reached formatted output");
  }
  assertEquals(formatted, "docs/example.md:1: secret.tree/aws-access-key-id");
});

Deno.test("oversized matched lines never inflate formatted output", () => {
  const hits = scanText(
    "docs/example.md",
    `${"x".repeat(100_000)} ${awsKeyFixture()} ${"y".repeat(100_000)}\n`,
  );
  assertEquals(hits.length, 1);
  const formatted = formatHits(hits);
  if (formatted.length > 500) {
    throw new Error(`formatted output too large: ${formatted.length} chars`);
  }
});

Deno.test("hostile long lines scan in linear time", () => {
  // 200k characters of address-shaped noise exercises the email matcher at
  // every `@`; the old backtracking regex took seconds here. The generous
  // bound only guards against a quadratic regression, not scheduler noise.
  const line = `${"x@".repeat(100_000)} ${awsKeyFixture()}`;
  const start = performance.now();
  const hits = scanText("docs/example.md", line);
  const elapsedMs = performance.now() - start;
  assertEquals(hits.map((hit) => hit.rule), [
    "secret.tree/aws-access-key-id",
  ]);
  if (elapsedMs > 2_000) {
    throw new Error(`hostile-line scan too slow: ${Math.round(elapsedMs)}ms`);
  }
});

Deno.test("bounded windows still detect oversized address shapes", () => {
  const longLocal = `${"x".repeat(200)}@gmail.com`;
  assertEquals(scanText("docs/example.md", `${longLocal}\n`).length, 1);
});

Deno.test("control bytes in paths are stripped from formatted output", () => {
  const hits = scanText(
    "docs/\x1b[2Jevil\rname.md",
    `key ${awsKeyFixture()}\n`,
  );
  const formatted = formatHits(hits);
  for (const ch of formatted) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error("control byte reached formatted output");
    }
  }
  assertEquals(
    formatted,
    "docs/[2Jevilname.md:1: secret.tree/aws-access-key-id",
  );
});

Deno.test("hit reporting is capped", () => {
  const lines = Array.from(
    { length: MAX_REPORTED_HITS + 10 },
    () => `key ${awsKeyFixture()}`,
  ).join("\n");
  const hits = scanText("docs/example.md", lines);
  assertEquals(hits.length, MAX_REPORTED_HITS + 10);
  const formatted = formatHits(hits).split("\n");
  assertEquals(formatted.length, MAX_REPORTED_HITS + 1);
  assertEquals(formatted.at(-1), "… and 10 more hits not shown");
});

Deno.test("scanText stops collecting at the given limit", () => {
  const lines = Array.from(
    { length: 40 },
    () => `key ${awsKeyFixture()}`,
  ).join("\n");
  assertEquals(scanText("docs/example.md", lines, 7).length, 7);
  assertEquals(scanText("docs/example.md", lines, 0), []);
});

Deno.test("a failed tracked-file read is value-free and fail-closed", async () => {
  let message = "";
  try {
    await readTrackedFile(
      "/nonexistent-root-for-this-test",
      "docs/\x1b[2Jevil.md",
      "public-safety scan",
    );
    throw new Error("expected readTrackedFile to throw");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(
    message,
    "public-safety scan: cannot read tracked file docs/[2Jevil.md",
  );
});

Deno.test({
  name: "a tracked symlink is scanned as its link-target text, not followed",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "dyfj-scan-symlink-" });
    try {
      // A generic assembled target that a followed read could never satisfy:
      // it points outside the repository and does not exist. Git tracks a
      // symlink as a blob holding exactly this text, so the scan must see
      // these bytes and flag the boundary shape they carry.
      const target = ["", "home", "someone", "private-overlay"].join("/");
      // Deno 2.9.6 rejects path-scoped read/write grants for Deno.symlink,
      // so the link is created via the already-allowed `ln`. Output is piped
      // and never relayed: only the exit status is inspected.
      const ln = await new Deno.Command("ln", {
        args: ["-s", target, `${root}/link`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!ln.success) {
        throw new Error(`ln -s failed (exit ${ln.code})`);
      }
      const bytes = await readTrackedFile(root, "link", "public-safety scan");
      const content = new TextDecoder().decode(bytes);
      assertEquals(content, target);
      assertEquals(scanText("link", content).map((hit) => hit.rule), [
        "public.boundary/home-directory-path",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

function envOf(
  vars: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

async function gitIn(dir: string, args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "dyfj-test",
      GIT_AUTHOR_EMAIL: "gate@example.invalid",
      GIT_COMMITTER_NAME: "dyfj-test",
      GIT_COMMITTER_EMAIL: "gate@example.invalid",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`git ${args[0]} failed in fixture (exit ${result.code})`);
  }
}

// A repository whose only commit is empty: everything written afterwards is
// untracked, which is exactly the inventory gap under test.
async function makeWorktreeFixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-scan-untracked-" });
  await gitIn(dir, ["init", "-q"]);
  await gitIn(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return dir;
}

Deno.test("an untracked non-ignored file is scanned locally, never in CI", async () => {
  const dir = await makeWorktreeFixture();
  try {
    await Deno.writeTextFile(
      `${dir}/new-notes.txt`,
      `token ${awsKeyFixture()}\n`,
    );
    // `git ls-files` cannot see this file at all, so before the untracked
    // inventory existed the value was invisible to every local lane.
    const local = await scanTree(dir, RULES, envOf({}));
    assertEquals(local.untrackedScanned, true);
    assertEquals(local.coverage, {
      inventoryBound: false,
      truncatedPaths: [],
      unlistedTruncated: 0,
    });
    assertEquals(local.hits, [{
      path: "new-notes.txt",
      line: 1,
      rule: "secret.tree/aws-access-key-id",
    }]);
    // CI scans the committed subject exactly, and reaches the same verdict by
    // a different route: `subject.resolve` fails closed on a subject tree
    // that carries untracked files, so nothing is silently admitted.
    const ci = await scanTree(dir, RULES, envOf({ GITHUB_ACTIONS: "true" }));
    assertEquals(ci.untrackedScanned, false);
    assertEquals(ci.hits, []);
    assertEquals(await isWorktreeClean(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an ignored file stays excluded from the untracked inventory", async () => {
  const dir = await makeWorktreeFixture();
  try {
    await Deno.writeTextFile(`${dir}/.gitignore`, "ignored-local/\n");
    await Deno.mkdir(`${dir}/ignored-local`);
    await Deno.writeTextFile(
      `${dir}/ignored-local/key.txt`,
      `token ${awsKeyFixture()}\n`,
    );
    // An ignored path is deliberately outside the publication surface: it
    // must not enter the inventory, and must not produce a hit.
    const inventory = await untrackedFiles(dir, "public-safety scan");
    assertEquals(inventory.paths, [".gitignore"]);
    assertEquals(inventory.truncated, false);
    const local = await scanTree(dir, RULES, envOf({}));
    assertEquals(local.hits, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hostile untracked filenames and content stay out of diagnostics", async () => {
  const dir = await makeWorktreeFixture();
  const value = awsKeyFixture();
  try {
    await Deno.writeTextFile(
      `${dir}/evil\x1b[2J\rname.txt`,
      `token ${value}\n`,
    );
    const { hits } = await scanTree(dir, RULES, envOf({}));
    assertEquals(hits.length, 1);
    const formatted = formatHits(hits);
    if (formatted.includes(value)) {
      throw new Error("untracked content reached formatted output");
    }
    for (const ch of formatted) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw new Error("control byte reached formatted output");
      }
    }
    assertEquals(
      formatted,
      "evil[2Jname.txt:1: secret.tree/aws-access-key-id",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "an untracked symlink is read as link text, never followed",
  ignore: Deno.build.os === "windows",
  async fn() {
    const outside = await Deno.makeTempDir({ prefix: "dyfj-scan-outside-" });
    const dir = await makeWorktreeFixture();
    try {
      // The target carries a secret shape and lives outside the repository:
      // a followed read would report it, so an empty secret result proves
      // containment.
      await Deno.writeTextFile(
        `${outside}/target.txt`,
        `token ${awsKeyFixture()}\n`,
      );
      // Deno 2.9.6 rejects path-scoped grants for Deno.symlink, so the link
      // is created via the already-allowed `ln`; output is never relayed.
      const ln = await new Deno.Command("ln", {
        args: ["-s", `${outside}/target.txt`, `${dir}/link.txt`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!ln.success) throw new Error(`ln -s failed (exit ${ln.code})`);
      const { hits } = await scanTree(dir, RULES, envOf({}));
      assertEquals(
        hits.filter((hit) => hit.rule.startsWith("secret.tree/")),
        [],
      );
      const read = await readUntrackedFile(
        dir,
        "link.txt",
        "public-safety scan",
      );
      assertEquals(read.truncated, false);
      assertEquals(
        new TextDecoder().decode(read.bytes),
        `${outside}/target.txt`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test("an oversized untracked file cannot produce a clean pass", async () => {
  const dir = await makeWorktreeFixture();
  try {
    // An untracked tree can hold build artifacts no tracked-file bound ever
    // had to cover, so the read still stops at the prefix bound. What it must
    // never do is call the unread remainder clean: the secret shape below sits
    // past the bound and is never scanned, so the run fails on coverage.
    await Deno.writeTextFile(
      `${dir}/artifact.bin`,
      `${"x".repeat(MAX_UNTRACKED_FILE_BYTES)}\ntoken ${awsKeyFixture()}\n`,
    );
    const read = await readUntrackedFile(
      dir,
      "artifact.bin",
      "public-safety scan",
    );
    assertEquals(read.bytes.length, MAX_UNTRACKED_FILE_BYTES);
    assertEquals(read.truncated, true);

    const result = await scanTree(dir, RULES, envOf({}));
    // The bytes past the bound really are unscanned — hence no hit — which is
    // exactly why the gap has to be recorded.
    assertEquals(result.hits, []);
    assertEquals(result.coverage.truncatedPaths, ["artifact.bin"]);
    assertEquals(result.coverage.unlistedTruncated, 0);

    const capture = captureOut();
    assertEquals(await runTreeScan(dir, RULES, envOf({}), capture.out), 1);
    assertStringIncludes(capture.text(), "incomplete coverage");
    assertStringIncludes(
      capture.text(),
      "artifact.bin: read only its leading bytes",
    );
    if (capture.text().includes("clean")) {
      throw new Error("partial coverage reported as a clean pass");
    }
    if (capture.text().includes(awsKeyFixture())) {
      throw new Error("secret-shaped content reached scan output");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a file exactly at the byte bound is fully read, not a gap", async () => {
  const dir = await makeWorktreeFixture();
  try {
    // The boundary case must not fail closed: every byte was read, so this is
    // complete coverage and a clean pass is honest.
    await Deno.writeTextFile(
      `${dir}/exact.bin`,
      "x".repeat(MAX_UNTRACKED_FILE_BYTES),
    );
    const read = await readUntrackedFile(
      dir,
      "exact.bin",
      "public-safety scan",
    );
    assertEquals(read.bytes.length, MAX_UNTRACKED_FILE_BYTES);
    assertEquals(read.truncated, false);
    const capture = captureOut();
    assertEquals(await runTreeScan(dir, RULES, envOf({}), capture.out), 0);
    assertStringIncludes(capture.text(), "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the CI marker reader answers only its own permitted variable", () => {
  // Never reads a variable outside the grant, and never prompts: an ungranted
  // name simply reads as absent, which selects local feedback.
  const reader = permittedEnvReader("GITHUB_ACTIONS");
  assertEquals(reader("DYFJ_GATE_SUBJECT"), undefined);
  const ungranted = "DYFJ_NOT_GRANTED_FOR_TEST";
  assertEquals(permittedEnvReader(ungranted)(ungranted), undefined);
});

Deno.test("an overflowing untracked count cannot produce a clean pass", async () => {
  const dir = await makeWorktreeFixture();
  try {
    for (let index = 0; index <= MAX_UNTRACKED_FILES; index++) {
      await Deno.writeTextFile(
        `${dir}/file-${String(index).padStart(6, "0")}.txt`,
        "clean\n",
      );
    }
    const inventory = await untrackedFiles(dir, "public-safety scan");
    assertEquals(inventory.paths.length, MAX_UNTRACKED_FILES);
    // A capped inventory must never be reported as full coverage.
    assertEquals(inventory.truncated, true);
    const local = await scanTree(dir, RULES, envOf({}));
    assertEquals(local.coverage.inventoryBound, true);
    // Every file the bound admitted is clean, so hit-based failure alone would
    // exit 0 here while an unknown number of files went unopened.
    assertEquals(local.hits, []);

    const capture = captureOut();
    assertEquals(await runTreeScan(dir, RULES, envOf({}), capture.out), 1);
    assertStringIncludes(capture.text(), "incomplete coverage");
    assertStringIncludes(
      capture.text(),
      "untracked inventory reached its file-count bound",
    );
    if (capture.text().includes("clean (")) {
      throw new Error("capped inventory reported as a clean pass");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CI keeps authoritative tracked-tree coverage despite local bounds", async () => {
  const dir = await makeWorktreeFixture();
  try {
    // An untracked artifact past the per-file bound would fail a local run.
    // CI scans the committed subject exactly — `subject.resolve` rejects a
    // dirty tree instead — so its coverage is complete and its verdict clean.
    await Deno.writeTextFile(
      `${dir}/artifact.bin`,
      `${"x".repeat(MAX_UNTRACKED_FILE_BYTES)}\ntoken ${awsKeyFixture()}\n`,
    );
    const ci = await scanTree(dir, RULES, envOf({ GITHUB_ACTIONS: "true" }));
    assertEquals(ci.untrackedScanned, false);
    assertEquals(ci.coverage, {
      inventoryBound: false,
      truncatedPaths: [],
      unlistedTruncated: 0,
    });
    const capture = captureOut();
    assertEquals(
      await runTreeScan(
        dir,
        RULES,
        envOf({ GITHUB_ACTIONS: "true" }),
        capture.out,
      ),
      0,
    );
    assertStringIncludes(capture.text(), "clean (tracked files)");
    assertEquals(await isWorktreeClean(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed untracked-file read is value-free and fail-closed", async () => {
  let message = "";
  try {
    await readUntrackedFile(
      "/nonexistent-root-for-this-test",
      "notes/\x1b[2Jevil.txt",
      "public-safety scan",
    );
    throw new Error("expected readUntrackedFile to throw");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(
    message,
    "public-safety scan: cannot read untracked file notes/[2Jevil.txt",
  );
});

Deno.test("an ordinary tracked file still reads its own bytes", async () => {
  const root = await Deno.makeTempDir({ prefix: "dyfj-scan-plain-" });
  try {
    await Deno.writeTextFile(`${root}/plain.txt`, "plain fixture content\n");
    const bytes = await readTrackedFile(
      root,
      "plain.txt",
      "public-safety scan",
    );
    assertEquals(new TextDecoder().decode(bytes), "plain fixture content\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
