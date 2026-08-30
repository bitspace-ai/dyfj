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
  scanToolchainText,
  scanWorkflowText,
  SOURCE_CLASSES,
  type SourceClass,
} from "./dependency-policy.ts";
import { repoRootFromMeta, trackedFiles } from "./scan-lib.ts";
import { formatHits } from "./public-safety-scan.ts";
import { headCommit } from "./subject-check.ts";

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
    "scripts/dependency-policy-manifest.json",
  ];
  for (const path of surfaces) {
    assertEquals(isDependencySurface(path), true);
  }
  for (const path of ["README.md", "scripts/scan-lib.ts", "schema/x.sql"]) {
    assertEquals(isDependencySurface(path), false);
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
    surfaceOf(m, 0).source_class = "npm-registry";
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
