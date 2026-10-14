import {
  coverageHits,
  declaredSurfacePaths,
  dependencyPolicyHits,
  isDependencySurface,
  loadManifest,
  manifestDigest,
  manifestViolations,
  mutatedSurfaces,
  REQUIRED_EVIDENCE_BY_SOURCE,
  scanDependabotText,
  scanNpmPackage,
  scanToolchainText,
  scanWorkflowText,
  SOURCE_CLASSES,
  type SourceClass,
} from "./dependency-policy.ts";
import { repoRootFromMeta, trackedFiles } from "./scan-lib.ts";
import { formatHits } from "./public-safety-scan.ts";
import { headCommit } from "./subject-check.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
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

const WF = ".github/workflows/example.yml";
const DIGEST = "1".repeat(40);

Deno.test("digest-pinned action references pass", () => {
  const content = [
    "steps:",
    `  - uses: actions/checkout@${DIGEST} # v4.2.2`,
    `  - uses: "denoland/setup-deno@${DIGEST}"`,
  ].join("\n");
  assertEquals(scanWorkflowText(WF, content), []);
});

Deno.test("tag, branch, and short-digest action references fail", () => {
  const references = [
    "uses: actions/checkout@v4",
    "uses: actions/checkout@main",
    `uses: actions/checkout@${"1".repeat(12)}`,
    "uses: actions/checkout",
  ];
  for (const line of references) {
    const hits = scanWorkflowText(WF, `steps:\n  - ${line}\n`);
    assertEquals(hits.map((hit) => hit.rule), [
      "dependency.policy/unpinned-action",
    ]);
  }
});

Deno.test("mutable installer URLs fail", () => {
  const lines = [
    "      run: curl -fsSL -o /tmp/x https://example.invalid/releases/latest/download/install.sh",
    "      run: wget https://raw.githubusercontent.com/owner/repo/main/setup.sh",
  ];
  for (const line of lines) {
    const hits = scanWorkflowText(WF, `${line}\n`);
    assertEquals(hits.map((hit) => hit.rule), [
      "dependency.policy/mutable-installer-url",
    ]);
  }
});

Deno.test("piping a download into a shell fails", () => {
  const lines = [
    "      run: curl -fsSL https://example.invalid/install.sh | sh",
    "      run: curl -fsSL https://example.invalid/install.sh | sudo bash",
    "      run: wget -qO- https://example.invalid/i.sh | dash",
  ];
  for (const line of lines) {
    const hits = scanWorkflowText(WF, `${line}\n`);
    assertEquals(hits.map((hit) => hit.rule), [
      "dependency.policy/pipe-to-shell",
    ]);
  }
});

// A `run:` value is a shell script, not a set of independent lines. Each
// form below spreads one network-to-shell command over several physical
// lines, so a line-at-a-time scan reports nothing while the job still runs
// downloaded bytes as a script.
const MULTILINE_PIPELINES: [string, string[], number][] = [
  ["literal block, pipe at end of line", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: |",
    "          curl -fsSL https://example.invalid/i.sh |",
    "            sh",
  ], 5],
  ["literal block, backslash continuation before the pipe", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: |",
    "          wget -qO- https://example.invalid/i.sh \\",
    "            | bash",
  ], 5],
  ["folded block scalar", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: >",
    "          curl -fsSL https://example.invalid/i.sh",
    "          | sudo sh",
  ], 5],
  ["multi-line plain scalar", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: curl -fsSL https://example.invalid/i.sh |",
    "          sh",
  ], 4],
  ["quoted scalar folded across lines", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: 'wget -qO- https://example.invalid/i.sh |",
    "          dash'",
  ], 4],
  ["indented plain scalar under a bare key", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run:",
    "          curl -fsSL https://example.invalid/i.sh |",
    "          zsh",
  ], 5],
];

Deno.test("a multiline curl or wget pipeline into a shell fails", () => {
  for (const [form, lines, line] of MULTILINE_PIPELINES) {
    const hits = scanWorkflowText(WF, `${lines.join("\n")}\n`);
    if (
      hits.length !== 1 || hits[0]?.rule !== "dependency.policy/pipe-to-shell"
    ) {
      throw new Error(
        `${form}: expected one pipe-to-shell hit, got ${JSON.stringify(hits)}`,
      );
    }
    assertEquals(hits[0]?.line, line);
  }
});

Deno.test("a pipeline reaching a shell through a filter fails", () => {
  const content = [
    "      - run: |",
    "          curl -fsSL https://example.invalid/i.sh \\",
    "            | tee /tmp/i.sh \\",
    "            | /bin/bash",
  ].join("\n");
  const hits = scanWorkflowText(WF, `${content}\n`);
  assertEquals(hits.map((hit) => hit.rule), [
    "dependency.policy/pipe-to-shell",
  ]);
});

Deno.test("quoting or escaping the shell name does not evade the policy", () => {
  for (const stage of ['"/bin/sh"', "'sh'", "s\\h", "env bash"]) {
    const content =
      `      - run: curl -fsSL https://example.invalid/i.sh | ${stage}`;
    const hits = scanWorkflowText(WF, `${content}\n`);
    assertEquals(hits.map((hit) => hit.rule), [
      "dependency.policy/pipe-to-shell",
    ]);
  }
});

Deno.test("a comment character cannot hide the rest of a pipeline", () => {
  // `#` inside a quoted word is data, not a comment: stripping from the first
  // `#` would drop the pipe and pass this workflow.
  const hidden = '      - run: curl -fsSL "https://example.invalid/a#b" | sh';
  assertEquals(scanWorkflowText(WF, `${hidden}\n`).map((hit) => hit.rule), [
    "dependency.policy/pipe-to-shell",
  ]);
  // A real comment at a word start ends the command, exactly as the shell
  // reads it.
  const commented =
    "      - run: curl -fsSL -o /tmp/i.sh https://example.invalid/i.sh # | sh";
  assertEquals(scanWorkflowText(WF, `${commented}\n`), []);
});

Deno.test("a run block whose structure is not understood fails closed", () => {
  const blocks: [string, string[]][] = [
    ["unterminated quote", [
      "      - run: |",
      '          echo "unterminated',
    ]],
    ["unclosed command substitution", [
      "      - run: |",
      "          echo $(cat /tmp/x",
    ]],
    ["dangling pipeline operator", [
      "      - run: |",
      "          curl -fsSL https://example.invalid/i.sh |",
    ]],
    ["alias in place of a script", [
      "      - run: *install",
    ]],
    ["tab in the block indentation", [
      "      - run: |",
      "          \tcurl -fsSL https://example.invalid/i.sh",
    ]],
    ["block scalar with no body", [
      "      - run: |",
      "      - name: next",
    ]],
  ];
  for (const [form, lines] of blocks) {
    const hits = scanWorkflowText(WF, `${lines.join("\n")}\n`);
    if (!hits.some((hit) => hit.rule === "dependency.policy/unparsed-shell")) {
      throw new Error(`${form}: an unreadable run block was accepted`);
    }
    assertEquals(hits[0]?.line, 1);
  }
});

Deno.test("a verified-download block is not a network-to-shell hit", () => {
  // The shape the gate actually runs: download to a file, check a committed
  // digest, unpack. Separate commands, and the only pipes feed a checksum
  // verifier and a version filter.
  const content = [
    "      - run: |",
    "          set -euo pipefail",
    "          curl -fsSL -o /tmp/deno.zip \\",
    '            "https://example.invalid/download/v1.0.0/deno.zip"',
    "          printf '%s  %s\\n' \"" + "a".repeat(64) +
    '" /tmp/deno.zip | sha256sum -c -',
    '          unzip -q -o /tmp/deno.zip -d "$HOME/.deno-pinned"',
    '          "$HOME/.deno-pinned/deno" --version | grep -F "deno 1.0.0"',
  ].join("\n");
  assertEquals(scanWorkflowText(WF, `${content}\n`), []);
});

Deno.test("piping to a non-shell filter is not a policy hit", () => {
  const content = [
    '      run: curl -fsSL -o /tmp/deno.zip "https://example.invalid/v1.0.0/deno.zip"',
    '      run: deno --version | grep -F "deno 2.9.6"',
  ].join("\n");
  assertEquals(scanWorkflowText(WF, content), []);
});

Deno.test("the toolchain pin must be an exact version", () => {
  assertEquals(
    scanToolchainText("core/rust-toolchain.toml", 'channel = "1.98.0"\n'),
    [],
  );
  for (
    const content of [
      'channel = "stable"\n',
      'channel = "1.98"\n',
      "[toolchain]\ncomponents = []\n",
    ]
  ) {
    const hits = scanToolchainText("core/rust-toolchain.toml", content);
    assertEquals(hits.map((hit) => hit.rule), [
      "dependency.policy/unpinned-toolchain",
    ]);
  }
});

Deno.test("dependency surfaces are classified deterministically", () => {
  const surfaces = [
    ".github/workflows/gate.yml",
    ".github/dependabot.yml",
    "deno.json",
    "prototype/deno.lock",
    "core/Cargo.toml",
    "core/Cargo.lock",
    "core/rust-toolchain.toml",
    "prototype/package.json",
    "prototype/package-lock.json",
    "prototype/.npmrc",
    "scripts/dependency-policy-manifest.json",
  ];
  for (const path of surfaces) {
    assertEquals(isDependencySurface(path), true);
  }
  for (const path of ["README.md", "scripts/scan-lib.ts", "schema/x.sql"]) {
    assertEquals(isDependencySurface(path), false);
  }
});

const PKG = "prototype/package.json";
const NPMRC = "save-exact=true\nignore-scripts=true\nmin-release-age=3\n";

function packageJson(dependencies: Record<string, unknown>): string {
  return JSON.stringify({ private: true, dependencies }, null, 2) + "\n";
}

function npmRules(
  content: string,
  siblings: { lockfile?: boolean; npmrc?: string | undefined } = {},
): string[] {
  return scanNpmPackage(PKG, content, {
    lockfile: siblings.lockfile ?? true,
    npmrc: "npmrc" in siblings ? siblings.npmrc : NPMRC,
  }).map((hit) => hit.rule);
}

test("an exactly pinned npm package with its lockfile and npmrc passes", () => {
  assertEquals(
    npmRules(packageJson({ zod: "4.6.5", "@scope/pkg": "1.0.0-rc.1" })),
    [],
  );
});

test("a non-exact npm version range fails", () => {
  for (
    const range of [
      "^4.6.5",
      "~4.6.5",
      ">=4.6.5",
      "4.6",
      "4.x",
      "*",
      "latest",
      "4.6.5 || 5.0.0",
      "github:owner/repo",
      "file:../pkg",
      "4.6.5+build",
    ]
  ) {
    assertEquals(npmRules(packageJson({ zod: range })), [
      "dependency.policy/npm-range-version",
    ]);
  }
  // Every dependency field is checked, not only `dependencies`.
  for (
    const field of [
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]
  ) {
    const content = JSON.stringify({ [field]: { zod: "^4.6.5" } });
    assertEquals(npmRules(content), ["dependency.policy/npm-range-version"]);
  }
});

test("an npm range hit names the line of the offending entry", () => {
  const hits = scanNpmPackage(
    PKG,
    packageJson({ ulid: "3.0.2", zod: "^4.6.5" }),
    { lockfile: true, npmrc: NPMRC },
  );
  assertEquals(hits, [{
    path: PKG,
    line: 5,
    rule: "dependency.policy/npm-range-version",
  }]);
});

test("a package.json without a tracked lockfile fails", () => {
  assertEquals(npmRules(packageJson({ zod: "4.6.5" }), { lockfile: false }), [
    "dependency.policy/npm-missing-lockfile",
  ]);
});

test("install scripts must be disabled by a tracked npmrc", () => {
  const content = packageJson({ zod: "4.6.5" });
  for (
    const npmrc of [
      undefined,
      "",
      "save-exact=true\nmin-release-age=3\n",
      "ignore-scripts=false\nmin-release-age=3\n",
      "ignore-scripts=true\nignore-scripts=false\nmin-release-age=3\n",
      "# ignore-scripts=true\nmin-release-age=3\n",
    ]
  ) {
    assertEquals(
      npmRules(content, { npmrc }).includes(
        "dependency.policy/npm-install-scripts",
      ),
      true,
    );
  }
  assertEquals(
    npmRules(content, { npmrc: " ignore-scripts = true \nmin-release-age=3" }),
    [],
  );
});

test("the npm release-age floor must hold at install time", () => {
  const content = packageJson({ zod: "4.6.5" });
  for (
    const npmrc of [
      "ignore-scripts=true\n",
      "ignore-scripts=true\nmin-release-age=2\n",
      "ignore-scripts=true\nmin-release-age=three\n",
    ]
  ) {
    assertEquals(npmRules(content, { npmrc }), [
      "dependency.policy/npm-release-age",
    ]);
  }
  assertEquals(
    npmRules(content, { npmrc: "ignore-scripts=true\nmin-release-age=7\n" }),
    [],
  );
});

test("an npm overrides field fails closed at its line", () => {
  // Overrides replace versions anywhere in the tree, so an exact pin in
  // dependencies proves nothing about what they select. They are rejected
  // until a policy for them exists.
  const content = JSON.stringify(
    { dependencies: { zod: "4.6.5" }, overrides: { ulid: "3.0.2" } },
    null,
    2,
  );
  assertEquals(
    scanNpmPackage(PKG, content, { lockfile: true, npmrc: NPMRC }),
    [{
      path: PKG,
      line: 5,
      rule: "dependency.policy/npm-overrides-unsupported",
    }],
  );
});

test("an unparseable package.json fails closed", () => {
  for (const content of ["{", "[]", '{"dependencies": ["zod"]}']) {
    assertEquals(npmRules(content), [
      "dependency.policy/npm-unparsed-manifest",
    ]);
  }
});

const DEPENDABOT = ".github/dependabot.yml";

// A Dependabot config with one npm lane and one deno lane for `prototype/`,
// with `npm` and `deno` replaced by the given entry bodies.
function dependabotConfig(npm: string, deno: string): string {
  return [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/prototype"',
    npm,
    '  - package-ecosystem: "deno"',
    '    directory: "/prototype"',
    deno,
    '  - package-ecosystem: "cargo"',
    '    directory: "/core"',
    "    schedule:",
    '      interval: "weekly"',
    "",
  ].join("\n");
}

const NPM_LANE = [
  "    schedule:",
  '      interval: "weekly"',
  '    versioning-strategy: "increase"',
  "    cooldown:",
  "      default-days: 3",
  "    ignore:",
  '      - dependency-name: "@scope/pinned"',
].join("\n");
const DENO_LANE = [
  "    schedule:",
  '      interval: "weekly"',
  "    cooldown:",
  "      default-days: 3",
].join("\n");

function dependabotRules(
  content: string,
  packagePaths: readonly string[] = [PKG],
): string[] {
  return scanDependabotText(DEPENDABOT, content, packagePaths)
    .map((hit) => hit.rule);
}

test("a dependabot config watching npm with cooldown and exact bumps passes", () => {
  assertEquals(dependabotRules(dependabotConfig(NPM_LANE, DENO_LANE)), []);
});

test("a tracked package.json no npm update lane watches fails", () => {
  const withoutNpm = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "deno"',
    '    directory: "/prototype"',
    DENO_LANE,
    "",
  ].join("\n");
  assertEquals(scanDependabotText(DEPENDABOT, withoutNpm, [PKG]), [{
    path: PKG,
    line: 1,
    rule: "dependency.policy/dependabot-npm-unwatched",
  }]);
  // An npm lane for another directory does not watch this one, and a
  // root package.json is watched only by the "/" directory.
  const elsewhere = dependabotConfig(NPM_LANE, DENO_LANE)
    .replace('directory: "/prototype"', 'directory: "/other"');
  assertEquals(dependabotRules(elsewhere), [
    "dependency.policy/dependabot-npm-unwatched",
  ]);
  assertEquals(
    dependabotRules(dependabotConfig(NPM_LANE, DENO_LANE), ["package.json"]),
    ["dependency.policy/dependabot-npm-unwatched"],
  );
  assertEquals(
    dependabotRules(
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace('directory: "/prototype"', 'directory: "/"'),
      ["package.json"],
    ),
    [],
  );
});

test("npm and deno update lanes must hold the 72-hour cooldown", () => {
  const cooldownLanes = [
    // No cooldown at all: the floor would rest on an undeclared default.
    NPM_LANE.replace("    cooldown:\n      default-days: 3\n", ""),
    NPM_LANE.replace("default-days: 3", "default-days: 2"),
    NPM_LANE.replace("default-days: 3", "default-days: three"),
    NPM_LANE.replace("default-days: 3", "semver-major-days: 7"),
    NPM_LANE.replace(
      "default-days: 3",
      "default-days: 3\n      semver-patch-days: 1",
    ),
    // include and exclude both take dependencies out of the floor.
    NPM_LANE.replace(
      "default-days: 3",
      'default-days: 3\n      exclude:\n        - "zod"',
    ),
    NPM_LANE.replace(
      "default-days: 3",
      'default-days: 3\n      include:\n        - "zod"',
    ),
  ];
  for (const lane of cooldownLanes) {
    assertEquals(dependabotRules(dependabotConfig(lane, DENO_LANE)), [
      "dependency.policy/dependabot-cooldown",
    ]);
  }
  assertEquals(
    dependabotRules(dependabotConfig(
      NPM_LANE,
      DENO_LANE.replace("default-days: 3", "default-days: 1"),
    )),
    ["dependency.policy/dependabot-cooldown"],
  );
  // A longer cooldown, per bump level, still holds the floor.
  assertEquals(
    dependabotRules(dependabotConfig(
      NPM_LANE.replace(
        "default-days: 3",
        "default-days: 7\n      semver-major-days: 14",
      ),
      DENO_LANE,
    )),
    [],
  );
});

test("the npm update lane must bump exact pins with the increase strategy", () => {
  for (
    const lane of [
      NPM_LANE.replace('    versioning-strategy: "increase"\n', ""),
      NPM_LANE.replace('"increase"', '"widen"'),
      NPM_LANE.replace('"increase"', '"auto"'),
      NPM_LANE.replace('"increase"', '"lockfile-only"'),
    ]
  ) {
    assertEquals(dependabotRules(dependabotConfig(lane, DENO_LANE)), [
      "dependency.policy/dependabot-versioning-strategy",
    ]);
  }
});

test("a lane hit names the line of its update entry", () => {
  const content = dependabotConfig(
    NPM_LANE,
    DENO_LANE.replace("default-days: 3", "default-days: 1"),
  );
  assertEquals(scanDependabotText(DEPENDABOT, content, [PKG]), [{
    path: DEPENDABOT,
    line: 12,
    rule: "dependency.policy/dependabot-cooldown",
  }]);
});

test("an escaped quoted scalar fails closed instead of being trusted", () => {
  // YAML decodes escapes in a double-quoted scalar, so "de\u006eo" names the
  // deno ecosystem. The scan does not decode escapes; it rejects them, so a
  // spelling the scan cannot read never skips the cooldown check.
  const denoWithoutCooldown = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/prototype"',
    NPM_LANE,
    '  - package-ecosystem: "de\\u006eo"',
    '    directory: "/prototype"',
    "    schedule:",
    '      interval: "weekly"',
    "",
  ].join("\n");
  assertEquals(scanDependabotText(DEPENDABOT, denoWithoutCooldown, [PKG]), [{
    path: DEPENDABOT,
    line: 12,
    rule: "dependency.policy/dependabot-unparsed",
  }]);
  // Every scalar the policy decides on is held to the same rule.
  for (
    const content of [
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace('directory: "/prototype"', 'directory: "/proto\\x74ype"'),
      dependabotConfig(
        NPM_LANE.replace('"increase"', '"incr\\x65ase"'),
        DENO_LANE,
      ),
      dependabotConfig(
        NPM_LANE.replace("default-days: 3", 'default-days: "\\x33"'),
        DENO_LANE,
      ),
    ]
  ) {
    assertEquals(
      dependabotRules(content).includes(
        "dependency.policy/dependabot-unparsed",
      ),
      true,
    );
  }
  // A single-quoted scalar has only the '' escape, which is decoded; an
  // unterminated quote is not understood.
  assertEquals(
    dependabotRules(
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace('"npm"', "'npm'")
        .replace('"increase"', "'increase' # exact pins stay exact"),
    ),
    [],
  );
  assertEquals(
    dependabotRules(
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace('directory: "/prototype"', "directory: '/proto''type'"),
    ),
    ["dependency.policy/dependabot-npm-unwatched"],
  );
  assertEquals(
    dependabotRules(
      dependabotConfig(NPM_LANE, DENO_LANE).replace('"npm"', "'npm"),
    ).includes("dependency.policy/dependabot-unparsed"),
    true,
  );
});

test("a dependabot config whose structure is not understood fails closed", () => {
  for (
    const content of [
      "version: 2\n",
      "version: 2\nupdates: []\n",
      dependabotConfig(
        NPM_LANE.replace(
          "    cooldown:\n      default-days: 3",
          "    cooldown: { default-days: 3 }",
        ),
        DENO_LANE,
      ),
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace('  - package-ecosystem: "deno"\n', "  - schedule: {}\n"),
      dependabotConfig(NPM_LANE, DENO_LANE)
        .replace("    schedule:", "    directory: /x\n    schedule:"),
    ]
  ) {
    assertEquals(
      dependabotRules(content).includes(
        "dependency.policy/dependabot-unparsed",
      ),
      true,
    );
  }
});

Deno.test("hostile workflow content stays out of diagnostics", () => {
  const hostile = `uses: evil\x1b[2J@latest ${"x".repeat(1_000)}`;
  const hits = scanWorkflowText(WF, `  - ${hostile}\n`);
  assertEquals(hits.map((hit) => hit.rule), [
    "dependency.policy/unpinned-action",
  ]);
  const formatted = formatHits(hits);
  if (formatted.includes("evil") || formatted.length > 500) {
    throw new Error("workflow content reached formatted output");
  }
});

Deno.test("tracked workflow and toolchain files satisfy the policy", async () => {
  const hits = await dependencyPolicyHits(repoRootFromMeta());
  if (hits.length > 0) {
    throw new Error(
      `dependency policy violations in tracked files:\n${formatHits(hits)}`,
    );
  }
});

function validSurface(): Record<string, unknown> {
  return {
    id: "cargo.core",
    source_class: "cargo-registry",
    manifest_paths: ["core/Cargo.toml"],
    lock_paths: ["core/Cargo.lock"],
    required_evidence_classes: [
      ...REQUIRED_EVIDENCE_BY_SOURCE["cargo-registry"],
    ],
    age_policy: { class: "registry-minimum-hours", minimum_hours: 72 },
    mutable_references_allowed: false,
    integrity_evidence_classes: ["lockfile-integrity-hash"],
    provenance_evidence_classes: ["registry-source-provenance"],
    clean_room_check_ids: ["dependency.policy"],
    known_missing_evidence_classes: [],
  };
}

function validReleaseSurface(): Record<string, unknown> {
  return {
    id: "release.deno-archive",
    source_class: "github-release-asset",
    manifest_paths: [".github/workflows/gate.yml"],
    lock_paths: [],
    required_evidence_classes: [
      ...REQUIRED_EVIDENCE_BY_SOURCE["github-release-asset"],
    ],
    age_policy: {
      class: "not-applicable",
      reason_class: "non-registry-versioned-release",
    },
    mutable_references_allowed: false,
    integrity_evidence_classes: ["archive-checksum", "exact-version-url"],
    provenance_evidence_classes: ["upstream-release-provenance"],
    clean_room_check_ids: ["dependency.policy"],
    known_missing_evidence_classes: ["archive-signature"],
  };
}

// The not-applicable reason classes the source-class binding accepts; a
// registry source has none and must declare the registry floor instead.
const NOT_APPLICABLE_REASONS: Readonly<Record<string, string>> = {
  "rust-toolchain-release": "non-registry-versioned-release",
  "github-release-asset": "non-registry-versioned-release",
  "github-actions-config": "immutable-git-and-repository-config",
  "repository-owned-declaration": "repository-owned-content",
};

function validSurfaceFor(sourceClass: SourceClass): Record<string, unknown> {
  const reason = NOT_APPLICABLE_REASONS[sourceClass];
  return {
    id: `surface.${sourceClass}`,
    source_class: sourceClass,
    manifest_paths: ["example/manifest.json"],
    lock_paths: [],
    required_evidence_classes: [...REQUIRED_EVIDENCE_BY_SOURCE[sourceClass]],
    age_policy: reason === undefined
      ? { class: "registry-minimum-hours", minimum_hours: 72 }
      : { class: "not-applicable", reason_class: reason },
    mutable_references_allowed: false,
    integrity_evidence_classes: ["exact-version-pin"],
    provenance_evidence_classes: ["provenance-class"],
    clean_room_check_ids: ["dependency.policy"],
    known_missing_evidence_classes: sourceClass === "github-release-asset"
      ? ["archive-signature"]
      : [],
  };
}

function manifestWith(surface: Record<string, unknown>): unknown {
  return {
    schema: "dyfj.dependency.policy.manifest",
    version: 1,
    surfaces: [surface],
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schema: "dyfj.dependency.policy.manifest",
    version: 1,
    surfaces: [validSurface(), validReleaseSurface()],
  };
}

function surfaceOf(
  manifest: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return (manifest.surfaces as Record<string, unknown>[])[index] ?? {};
}

function assertViolation(
  mutate: (manifest: Record<string, unknown>) => void,
  expected: string,
): void {
  const manifest = validManifest();
  mutate(manifest);
  const violations = manifestViolations(manifest);
  if (!violations.includes(expected)) {
    throw new Error(
      `expected ${expected}, got [${violations.join(", ")}]`,
    );
  }
}

Deno.test("a valid dependency manifest has no violations", () => {
  assertEquals(manifestViolations(validManifest()), []);
});

Deno.test("manifest schema and shape discipline fails closed", () => {
  assertEquals(manifestViolations("nope"), [
    "dependency.manifest/not-an-object",
  ]);
  assertViolation((m) => {
    m.schema = "other.schema";
  }, "dependency.manifest/wrong-schema");
  assertViolation((m) => {
    m.version = 2;
  }, "dependency.manifest/unsupported-version");
  assertViolation((m) => {
    m.extra = true;
  }, "dependency.manifest/unknown-field");
  assertViolation((m) => {
    m.surfaces = [];
  }, "dependency.manifest/invalid:surfaces");
  assertViolation((m) => {
    surfaceOf(m, 1).id = "cargo.core";
  }, "dependency.manifest/duplicate-surface-id");
  assertViolation((m) => {
    surfaceOf(m, 0).surprise = true;
  }, "dependency.manifest/unknown-field");
  assertViolation((m) => {
    delete surfaceOf(m, 0).id;
  }, "dependency.manifest/invalid:id");
  assertViolation((m) => {
    surfaceOf(m, 0).source_class = "pypi-registry";
  }, "dependency.manifest/unknown-source-class");
});

Deno.test("manifest path declarations must be explicit", () => {
  assertViolation((m) => {
    surfaceOf(m, 0).manifest_paths = [];
  }, "dependency.manifest/invalid:manifest_paths");
  assertViolation((m) => {
    delete surfaceOf(m, 0).manifest_paths;
  }, "dependency.manifest/invalid:manifest_paths");
  // An omitted lock list is not the same claim as an explicit empty one.
  assertViolation((m) => {
    delete surfaceOf(m, 0).lock_paths;
  }, "dependency.manifest/invalid:lock_paths");
});

Deno.test("manifest age policy enforces the registry floor", () => {
  assertViolation((m) => {
    surfaceOf(m, 0).age_policy = {
      class: "registry-minimum-hours",
      minimum_hours: 24,
    };
  }, "dependency.manifest/age-below-minimum");
  assertViolation((m) => {
    surfaceOf(m, 0).age_policy = { class: "not-applicable" };
  }, "dependency.manifest/missing-age-reason");
  assertViolation((m) => {
    surfaceOf(m, 0).age_policy = { class: "whenever" };
  }, "dependency.manifest/invalid:age_policy");
});

Deno.test("age policy is bound to the source class", () => {
  // Registry evasion: a shape-valid not-applicable reason cannot lift a
  // registry surface out of the age floor.
  assertViolation((m) => {
    surfaceOf(m, 0).age_policy = {
      class: "not-applicable",
      reason_class: "repository-owned-content",
    };
  }, "dependency.manifest/age-policy-source-mismatch");
  assertViolation((m) => {
    surfaceOf(m, 0).age_policy = {
      class: "not-applicable",
      reason_class: "non-registry-versioned-release",
    };
  }, "dependency.manifest/age-policy-source-mismatch");
  // Non-registry misuse: a release asset can neither pose as a registry
  // surface nor borrow another source's reason class.
  assertViolation((m) => {
    surfaceOf(m, 1).age_policy = {
      class: "registry-minimum-hours",
      minimum_hours: 72,
    };
  }, "dependency.manifest/age-policy-source-mismatch");
  assertViolation((m) => {
    surfaceOf(m, 1).age_policy = {
      class: "not-applicable",
      reason_class: "immutable-git-and-repository-config",
    };
  }, "dependency.manifest/age-policy-source-mismatch");
});

Deno.test("every source class validates with its full contract", () => {
  for (const sourceClass of SOURCE_CLASSES) {
    assertEquals(
      manifestViolations(manifestWith(validSurfaceFor(sourceClass))),
      [],
    );
  }
});

Deno.test("dropping one contract-required evidence class fails", () => {
  for (const sourceClass of SOURCE_CLASSES) {
    for (const dropped of REQUIRED_EVIDENCE_BY_SOURCE[sourceClass]) {
      const surface = validSurfaceFor(sourceClass);
      surface.required_evidence_classes = REQUIRED_EVIDENCE_BY_SOURCE[
        sourceClass
      ].filter((entry) => entry !== dropped);
      const violations = manifestViolations(manifestWith(surface));
      if (
        !violations.includes("dependency.manifest/missing-contract-evidence")
      ) {
        throw new Error("a dropped contract evidence class was accepted");
      }
    }
  }
  // The repository-owned declaration must also keep dependency.policy
  // among its clean-room checks.
  const surface = validSurfaceFor("repository-owned-declaration");
  surface.clean_room_check_ids = ["test.aggregate"];
  const violations = manifestViolations(manifestWith(surface));
  if (!violations.includes("dependency.manifest/missing-contract-evidence")) {
    throw new Error("a missing clean-room dependency.policy was accepted");
  }
});

Deno.test("manifest paths must be normalized repository-relative", () => {
  const rejected = [
    "/etc/hosts",
    "a/../b.json",
    "./a.json",
    "..",
    "a//b.json",
    "a.json/",
    "a\\b.json",
    "a/" + String.fromCharCode(0) + "b.json",
    "ab.json",
  ];
  for (const path of rejected) {
    assertViolation((m) => {
      surfaceOf(m, 0).manifest_paths = [path];
    }, "dependency.manifest/invalid-path");
    assertViolation((m) => {
      surfaceOf(m, 0).lock_paths = [path];
    }, "dependency.manifest/invalid-path");
  }
  const manifest = validManifest();
  surfaceOf(manifest, 0).manifest_paths = ["core/Cargo.toml"];
  assertEquals(manifestViolations(manifest), []);
});

Deno.test("manifest evidence declarations fail closed", () => {
  assertViolation((m) => {
    surfaceOf(m, 0).mutable_references_allowed = true;
  }, "dependency.manifest/mutable-references-allowed");
  assertViolation((m) => {
    surfaceOf(m, 0).required_evidence_classes = [];
  }, "dependency.manifest/missing-required-evidence");
  assertViolation((m) => {
    surfaceOf(m, 0).integrity_evidence_classes = [];
  }, "dependency.manifest/missing-integrity-evidence");
  assertViolation((m) => {
    surfaceOf(m, 0).provenance_evidence_classes = [];
  }, "dependency.manifest/missing-provenance-evidence");
  assertViolation((m) => {
    surfaceOf(m, 0).clean_room_check_ids = [];
  }, "dependency.manifest/missing-clean-room-checks");
  assertViolation((m) => {
    surfaceOf(m, 0).clean_room_check_ids = ["not.a.gate.check"];
  }, "dependency.manifest/unknown-check-id");
  assertViolation((m) => {
    surfaceOf(m, 0).integrity_evidence_classes = ["vibes"];
  }, "dependency.manifest/unknown-evidence-class");
});

Deno.test("a release asset cannot claim unverified archive integrity", () => {
  // Dropping the known-missing declaration silently upgrades the claim.
  assertViolation((m) => {
    surfaceOf(m, 1).known_missing_evidence_classes = [];
  }, "dependency.manifest/unverified-archive-claim");
  // A class cannot be both claimed as evidence and declared missing.
  assertViolation((m) => {
    surfaceOf(m, 1).integrity_evidence_classes = [
      "exact-version-url",
      "archive-signature",
    ];
  }, "dependency.manifest/contradictory-evidence");
});

Deno.test("every source class must require inspect-before-apply", () => {
  for (const sourceClass of SOURCE_CLASSES) {
    const contract = REQUIRED_EVIDENCE_BY_SOURCE[sourceClass];
    if (!contract.includes("operator-inspect-before-apply")) {
      throw new Error(
        `${sourceClass} may be applied without operator inspection`,
      );
    }
    const surface = validSurfaceFor(sourceClass);
    surface.required_evidence_classes = contract.filter(
      (entry) => entry !== "operator-inspect-before-apply",
    );
    const violations = manifestViolations(manifestWith(surface));
    if (!violations.includes("dependency.manifest/missing-contract-evidence")) {
      throw new Error(
        `${sourceClass} accepted a contract without inspect-before-apply`,
      );
    }
  }
});

Deno.test("inspect evidence cannot stand in for artifact evidence", () => {
  // Inspection records that a human looked; it is not a claim about the
  // bytes, so it can never be declared as integrity or provenance proof.
  for (const inspect of ["operator-inspect-before-apply", "inspect-result"]) {
    assertViolation((m) => {
      surfaceOf(m, 0).integrity_evidence_classes = [inspect];
    }, "dependency.manifest/inspect-as-artifact-evidence");
    assertViolation((m) => {
      surfaceOf(m, 0).provenance_evidence_classes = [inspect];
    }, "dependency.manifest/inspect-as-artifact-evidence");
  }
});

Deno.test("the committed manifest requires inspect-before-apply everywhere", async () => {
  const load = await loadManifest(repoRootFromMeta());
  assertEquals(load.violations, []);
  const surfaces = (load.manifest?.surfaces ?? []) as Record<string, unknown>[];
  if (surfaces.length === 0) throw new Error("manifest declares no surfaces");
  for (const surface of surfaces) {
    const required = surface.required_evidence_classes as string[];
    if (!required.includes("operator-inspect-before-apply")) {
      throw new Error("a declared surface omits inspect-before-apply");
    }
  }
});

Deno.test("the manifest digest is canonical and tamper-evident", async () => {
  const digest = await manifestDigest(validManifest());
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("manifest digest is not lowercase sha-256 hex");
  }
  const base = validManifest();
  const reordered = {
    surfaces: base.surfaces,
    version: base.version,
    schema: base.schema,
  };
  assertEquals(await manifestDigest(reordered), digest);
  const tampered = validManifest();
  surfaceOf(tampered, 0).id = "cargo.other";
  if (await manifestDigest(tampered) === digest) {
    throw new Error("a value change did not change the manifest digest");
  }
});

Deno.test("a missing or malformed manifest file fails closed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-dep-manifest-" });
  try {
    assertEquals((await loadManifest(dir)).violations, [
      "dependency.manifest/unreadable",
    ]);
    await Deno.mkdir(`${dir}/scripts`);
    const path = `${dir}/scripts/dependency-policy-manifest.json`;
    await Deno.writeTextFile(path, "{ not json");
    assertEquals((await loadManifest(dir)).violations, [
      "dependency.manifest/invalid-json",
    ]);
    await Deno.writeTextFile(path, '{"schema":"other.schema"}');
    const rejected = await loadManifest(dir);
    if (rejected.manifest !== undefined || rejected.violations.length === 0) {
      throw new Error("an invalid manifest was accepted");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an undeclared tracked dependency surface fails", () => {
  const declared = new Set(["core/Cargo.toml"]);
  const hits = coverageHits(
    ["core/Cargo.toml", "prototype/package.json", "README.md"],
    [],
    declared,
  );
  assertEquals(hits, [{
    path: "prototype/package.json",
    line: 1,
    rule: "dependency.policy/undeclared-surface",
  }]);
});

Deno.test("a changed dependency path outside every declaration fails", () => {
  const hits = coverageHits(
    [],
    ["tools/package.json", "docs/notes.md"],
    new Set<string>(),
  );
  assertEquals(hits, [{
    path: "tools/package.json",
    line: 1,
    rule: "dependency.policy/unmatched-surface-change",
  }]);
});

Deno.test("a deleted tracked dependency file is reported as mutated", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dyfj-dep-deleted-" });
  try {
    await gitIn(dir, ["init", "-q"]);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
    await gitIn(dir, ["add", "."]);
    await gitIn(dir, ["commit", "-q", "-m", "base"]);
    const base = await headCommit(dir);
    await Deno.remove(`${dir}/deno.json`);
    await gitIn(dir, ["add", "."]);
    await gitIn(dir, ["commit", "-q", "-m", "delete dependency surface"]);
    const mutated = await mutatedSurfaces(dir, {
      diffArgs: [base],
      authoritative: false,
      description: "fixture range",
    });
    assertEquals(mutated, ["deno.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the committed manifest validates and covers tracked surfaces", async () => {
  const root = repoRootFromMeta();
  const load = await loadManifest(root);
  assertEquals(load.violations, []);
  const tracked = await trackedFiles(root, "dependency policy test");
  const hits = coverageHits(
    tracked,
    [],
    declaredSurfacePaths(load.manifest ?? {}),
  );
  if (hits.length > 0) {
    throw new Error(
      `undeclared tracked dependency surfaces:\n${formatHits(hits)}`,
    );
  }
});

Deno.test("the committed manifest claims the verified archive checksum", async () => {
  const load = await loadManifest(repoRootFromMeta());
  assertEquals(load.violations, []);
  const surfaces = (load.manifest?.surfaces ?? []) as Record<string, unknown>[];
  const releases = surfaces.filter(
    (surface) => surface.source_class === "github-release-asset",
  );
  assertEquals(releases.length, 2);
  for (const surface of releases) {
    // The workflow checks a repository-committed SHA-256 before unpacking,
    // so the checksum is claimed evidence rather than a declared gap.
    const integrity = surface.integrity_evidence_classes as string[];
    if (!integrity.includes("archive-checksum")) {
      throw new Error("a verified archive checksum is not claimed");
    }
    const missing = surface.known_missing_evidence_classes as string[];
    if (missing.includes("archive-checksum")) {
      throw new Error("the verified checksum is still declared missing");
    }
  }
});

Deno.test("the committed manifest keeps the signature gap a known unknown", async () => {
  const load = await loadManifest(repoRootFromMeta());
  assertEquals(load.violations, []);
  const surfaces = (load.manifest?.surfaces ?? []) as Record<string, unknown>[];
  const releases = surfaces.filter(
    (surface) => surface.source_class === "github-release-asset",
  );
  assertEquals(releases.length, 2);
  for (const surface of releases) {
    const missing = surface.known_missing_evidence_classes as string[];
    const claimed = [
      ...surface.integrity_evidence_classes as string[],
      ...surface.provenance_evidence_classes as string[],
      ...surface.required_evidence_classes as string[],
    ];
    for (const gap of ["archive-signature"]) {
      if (!missing.includes(gap)) {
        throw new Error("archive signature gap is not declared as missing");
      }
      if (claimed.includes(gap)) {
        throw new Error("archive signature is misreported as verified");
      }
    }
  }
});

test("the committed manifest declares the npm surface under the registry floor", async () => {
  const load = await loadManifest(repoRootFromMeta());
  assertEquals(load.violations, []);
  const surfaces = (load.manifest?.surfaces ?? []) as Record<string, unknown>[];
  const npm = surfaces.filter((surface) => surface.id === "npm.prototype");
  assertEquals(npm.length, 1);
  const surface = npm[0]!;
  assertEquals(surface.source_class, "npm-registry");
  assertEquals(surface.manifest_paths, [
    "prototype/package.json",
    "prototype/.npmrc",
  ]);
  assertEquals(surface.lock_paths, ["prototype/package-lock.json"]);
  assertEquals(surface.age_policy, {
    class: "registry-minimum-hours",
    minimum_hours: 72,
  });
  // deno.workspace keeps the deno.json files and deno.lock only.
  const deno = surfaces.find((entry) => entry.id === "deno.workspace");
  assertEquals(deno?.manifest_paths, ["deno.json", "prototype/deno.json"]);
  assertEquals(deno?.lock_paths, ["prototype/deno.lock"]);
});

test("tracked npm packages are checked for lockfile and npmrc", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-dep-npm-"));
  try {
    await gitIn(dir, ["init", "-q"]);
    await mkdir(`${dir}/pkg`);
    await writeFile(
      `${dir}/pkg/package.json`,
      '{"dependencies": {"zod": "4.6.5"}}\n',
    );
    // The npmrc and lockfile exist on disk but are untracked: only tracked
    // files count.
    await writeFile(`${dir}/pkg/.npmrc`, "ignore-scripts=true\n");
    await writeFile(`${dir}/pkg/package-lock.json`, "{}\n");
    await gitIn(dir, ["add", "pkg/package.json"]);
    await gitIn(dir, ["commit", "-q", "-m", "base"]);
    const hits = await dependencyPolicyHits(dir);
    assertEquals(
      hits.filter((hit) => hit.path === "pkg/package.json")
        .map((hit) => hit.rule),
      [
        "dependency.policy/npm-missing-lockfile",
        "dependency.policy/npm-install-scripts",
        "dependency.policy/npm-release-age",
        // No tracked Dependabot config, so no npm lane watches it.
        "dependency.policy/dependabot-npm-unwatched",
      ],
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
