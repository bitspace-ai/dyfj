import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_TICKET_TTL_MS,
  defaultPublishReportPath,
  fillPublishArgv,
  MAX_ARGV_ELEMENTS,
  parsePublishArgv,
  parsePublishConfig,
  type PublishConfig,
  type PublishValues,
  publishReportPathFor,
  REFUSED_PROGRAMS,
} from "./publish-config.ts";

const WHERE = "/fixture/config.toml";

function values(overrides: Partial<PublishValues> = {}): PublishValues {
  return {
    repo: "/fixture/repo",
    branch: "chris/bit-786-host-publish-tool",
    head: "0123456789abcdef0123456789abcdef01234567",
    range: "origin/main...HEAD",
    issue: "BIT-786",
    implementer: "anthropic",
    report: "/tmp/report.log",
    ticket: "tkt-1",
    ...overrides,
  };
}

function table(publish: Record<string, unknown>): Record<string, unknown> {
  return { publish };
}

describe("publish config: an absent table", () => {
  it("means no publish tool at all", () => {
    assert.strictEqual(parsePublishConfig(null, WHERE), null);
    assert.strictEqual(parsePublishConfig({}, WHERE), null);
  });

  it("ships no default naming an operator path", () => {
    // The one defaulted path is the tool's own scratch file.
    assert.match(defaultPublishReportPath(), /\{ticket\}/);
    assert.ok(!defaultPublishReportPath().includes("scripts"));
    // The report directory must resolve to itself, so the default's parent
    // is already a resolved path (macOS puts the temp directory behind /var).
    const parent = dirname(dirname(defaultPublishReportPath()));
    assert.strictEqual(realpathSync(parent), parent);
  });
});

describe("publish config: the table", () => {
  it("parses both commands and the defaults", () => {
    const config = parsePublishConfig(
      table({
        pre_gate: ["./scripts/pre-gate", "--range={range}"],
        gate: ["./scripts/gate", "--report={report}"],
      }),
      WHERE,
    );
    assert.ok(config !== null);
    assert.deepStrictEqual(config.preGate, [
      "./scripts/pre-gate",
      "--range={range}",
    ]);
    assert.deepStrictEqual(config.gate, [
      "./scripts/gate",
      "--report={report}",
    ]);
    assert.strictEqual(config.gateTimeoutMs, DEFAULT_GATE_TIMEOUT_MS);
    assert.strictEqual(config.ticketTtlMs, DEFAULT_TICKET_TTL_MS);
    assert.strictEqual(config.reportPath, defaultPublishReportPath());
  });

  it("accepts an explicit report path and durations", () => {
    const config = parsePublishConfig(
      table({
        pre_gate: ["true"],
        gate: ["true"],
        report_path: "/tmp/gate-{ticket}.log",
        gate_timeout_ms: 60_000,
        ticket_ttl_ms: 120_000,
      }),
      WHERE,
    );
    assert.strictEqual(config?.reportPath, "/tmp/gate-{ticket}.log");
    assert.strictEqual(config?.gateTimeoutMs, 60_000);
    assert.strictEqual(config?.ticketTtlMs, 120_000);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({ pre_gate: ["true"], gate: ["true"], pusher: ["true"] }),
          WHERE,
        ),
      /unknown key publish\.pusher/,
    );
  });

  it("requires both commands", () => {
    assert.throws(
      () => parsePublishConfig(table({ gate: ["true"] }), WHERE),
      /both required/,
    );
    assert.throws(
      () => parsePublishConfig(table({ pre_gate: ["true"] }), WHERE),
      /both required/,
    );
  });

  it("refuses a non-table section", () => {
    assert.throws(
      () => parsePublishConfig({ publish: "nope" }, WHERE),
      /must be a table/,
    );
  });

  it("refuses a report path that names no ticket", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({
            pre_gate: ["true"],
            gate: ["true"],
            report_path: "/tmp/report.log",
          }),
          WHERE,
        ),
      /must put \{ticket\} in its final path component/,
    );
  });

  it("refuses a duration out of range or not a whole number", () => {
    for (
      const [key, value] of [
        ["gate_timeout_ms", 0],
        ["gate_timeout_ms", 99],
        ["gate_timeout_ms", 1.5],
        ["ticket_ttl_ms", 1_000],
        ["ticket_ttl_ms", 30 * 24 * 60 * 60 * 1_000],
      ] as const
    ) {
      assert.throws(
        () =>
          parsePublishConfig(
            table({ pre_gate: ["true"], gate: ["true"], [key]: value }),
            WHERE,
          ),
        new RegExp(`publish\\.${key}`),
      );
    }
  });
});

describe("publish config: the push and pull request commands", () => {
  const both = { pre_gate: ["true"], gate: ["true"] };

  it("parses both commands when both are configured", () => {
    const config = parsePublishConfig(
      table({
        ...both,
        push: ["git", "push", "origin", "{head}:refs/heads/{branch}"],
        open_pr: ["gh", "pr", "create", "--head={branch}"],
      }),
      WHERE,
    );
    assert.ok(config !== null);
    assert.deepStrictEqual(config.push, [
      "git",
      "push",
      "origin",
      "{head}:refs/heads/{branch}",
    ]);
    assert.deepStrictEqual(config.openPr, [
      "gh",
      "pr",
      "create",
      "--head={branch}",
    ]);
  });

  it("refuses either one alone, naming the missing key", () => {
    assert.throws(
      () =>
        parsePublishConfig(table({ ...both, push: ["git", "push"] }), WHERE),
      /publish\.open_pr is required/,
    );
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...both, open_pr: ["gh", "pr", "create"] }),
          WHERE,
        ),
      /publish\.push is required/,
    );
  });

  it("holds push to the same argv rules, naming the key", () => {
    for (
      const push of [
        // a shell where an argv belongs
        ["bash", "-c", "git push origin HEAD"],
        // a placeholder nobody declared
        ["git", "push", "{nope}"],
        // a control character
        ["git", "push", "oops\n"],
      ]
    ) {
      assert.throws(
        () =>
          parsePublishConfig(
            table({ ...both, push, open_pr: ["gh", "pr", "create"] }),
            WHERE,
          ),
        /publish\.push/,
      );
    }
  });

  it("leaves the config without them when neither is configured", () => {
    const config = parsePublishConfig(table(both), WHERE);
    assert.ok(config !== null);
    assert.ok(!("push" in config));
    assert.ok(!("openPr" in config));
  });
});

describe("publish config: one command's argv", () => {
  it("refuses a shell interpreter by name, whatever its path", () => {
    for (const name of REFUSED_PROGRAMS) {
      assert.throws(
        () => parsePublishArgv([`/bin/${name}`, "-c", "true"], "gate", WHERE),
        /shell or a text-evaluating runtime/,
      );
      assert.throws(
        () => parsePublishArgv([name, "-c", "true"], "gate", WHERE),
        /shell or a text-evaluating runtime/,
      );
    }
  });

  it("accepts a shell interpreter above argv[0] only", () => {
    assert.deepStrictEqual(
      parsePublishArgv(["./scripts/gate", "--shell=bash"], "gate", WHERE),
      ["./scripts/gate", "--shell=bash"],
    );
  });

  it("refuses a non-array, an empty array and a non-string element", () => {
    assert.throws(
      () => parsePublishArgv("./gate", "gate", WHERE),
      /must be an array/,
    );
    assert.throws(() => parsePublishArgv([], "gate", WHERE), /must not be empty/);
    assert.throws(
      () => parsePublishArgv(["./gate", 3], "gate", WHERE),
      /\[1\] must be a string/,
    );
    assert.throws(
      () => parsePublishArgv(["./gate", ""], "gate", WHERE),
      /\[1\] must not be empty/,
    );
  });

  it("refuses a control character", () => {
    assert.throws(
      () => parsePublishArgv(["./gate", "--x=a\nb"], "gate", WHERE),
      /control character/,
    );
  });

  it("refuses too many elements and too many bytes", () => {
    const many = Array.from({ length: MAX_ARGV_ELEMENTS + 1 }, () => "x");
    assert.throws(() => parsePublishArgv(many, "gate", WHERE), /the limit is/);
    const huge = ["./gate", "--x=" + "a".repeat(9_000)];
    assert.throws(() => parsePublishArgv(huge, "gate", WHERE), /bytes/);
  });

  it("refuses an undeclared placeholder and an unbalanced brace", () => {
    assert.throws(
      () => parsePublishArgv(["./gate", "--repo={owner}"], "gate", WHERE),
      /undeclared placeholder "\{owner\}"/,
    );
    assert.throws(
      () => parsePublishArgv(["./gate", "--repo={repo"], "gate", WHERE),
      /unbalanced brace/,
    );
  });

  it("refuses a flag carrying a placeholder that is not joined with =", () => {
    // A flag-shaped element must join its value: `--range{range}` would put
    // the value inside the flag token.
    assert.throws(
      () => parsePublishArgv(["./gate", "--range{range}"], "gate", WHERE),
      /join the value to the flag with "="/,
    );
    // A separate bare value element is allowed: it stands alone in the argv,
    // and filling it cannot turn it into a flag (`fillPublishArgv` refuses).
    assert.deepStrictEqual(
      parsePublishArgv(["./gate", "--range", "{range}"], "gate", WHERE),
      ["./gate", "--range", "{range}"],
    );
    assert.deepStrictEqual(
      parsePublishArgv(["./gate", "--range={range}"], "gate", WHERE),
      ["./gate", "--range={range}"],
    );
  });

  it("allows a bare value element carrying a placeholder", () => {
    assert.deepStrictEqual(
      parsePublishArgv(["./gate", "{repo}", "check"], "gate", WHERE),
      ["./gate", "{repo}", "check"],
    );
  });
});

describe("publish config: filling a template", () => {
  const config: PublishConfig = {
    preGate: ["./pre-gate", "--range={range}"],
    gate: ["./gate", "--report={report}", "{repo}"],
    reportPath: "/tmp/gate-{ticket}.log",
    gateTimeoutMs: 60_000,
    ticketTtlMs: 120_000,
  };

  it("substitutes within one element and never splits", () => {
    assert.deepStrictEqual(
      fillPublishArgv(config.gate, values({ report: "/tmp/a b.log" })),
      ["./gate", "--report=/tmp/a b.log", "/fixture/repo"],
    );
  });

  it("fills the report path per ticket", () => {
    assert.strictEqual(
      publishReportPathFor(config, values({ ticket: "tkt-9" })),
      "/tmp/gate-tkt-9.log",
    );
  });

  it("refuses a substituted element that would become a flag", () => {
    // The template element was a bare placeholder, so the value chose it.
    const templated = parsePublishArgv(["./gate", "{branch}"], "gate", WHERE);
    assert.throws(
      () => fillPublishArgv(templated, values({ branch: "--force" })),
      /refusing to pass a value as a flag/,
    );
    // A template that joined the value to a flag keeps it one argument.
    const joined = parsePublishArgv(["./gate", "--branch={branch}"], "gate", WHERE);
    assert.deepStrictEqual(
      fillPublishArgv(joined, values({ branch: "--force" })),
      ["./gate", "--branch=--force"],
    );
  });

  it("refuses a placeholder the caller supplied no value for", () => {
    const missing = { ...values() } as Record<string, string>;
    delete missing["head"];
    assert.throws(
      () =>
        fillPublishArgv(
          ["./gate", "--head={head}"],
          missing as unknown as PublishValues,
        ),
      /has no value/,
    );
  });
});

describe("publish config: what argv[0] may be", () => {
  const ok = { pre_gate: ["./pre-gate"], gate: ["./gate"] };

  it("must be a literal, never a placeholder", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...ok, gate: ["{repo}", "--x"] }),
          WHERE,
        ),
      /must be a literal/,
    );
  });

  it("must not be a shell or a text-evaluating runtime", () => {
    for (const name of REFUSED_PROGRAMS) {
      assert.throws(
        () =>
          parsePublishConfig(
            table({ ...ok, gate: [name, "-c", "true"] }),
            WHERE,
          ),
        /shell or a text-evaluating runtime/,
        `${name} must be refused`,
      );
    }
    for (const name of ["python", "python3", "python3.12", "/usr/bin/python3"]) {
      assert.throws(
        () =>
          parsePublishConfig(
            table({ ...ok, gate: [name, "-c", "print(1)"] }),
            WHERE,
          ),
        /shell or a text-evaluating runtime/,
        `${name} must be refused`,
      );
    }
  });

  it("refuses env before a shell anywhere in the array", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...ok, gate: ["./gate", "env", "sh", "-c", "true"] }),
          WHERE,
        ),
      /runs "env" before a shell/,
    );
    // `env` alone, setting a variable, is not a shell string.
    assert.doesNotThrow(() =>
      parsePublishConfig(
        table({ ...ok, gate: ["./gate", "env", "A=1"] }),
        WHERE,
      ));
  });
});

describe("publish config: the report path", () => {
  const ok = { pre_gate: ["./pre-gate"], gate: ["./gate"] };

  it("must carry {ticket} in its final component", () => {
    for (const path of [
      "/tmp/{ticket}/run.log",
      "/tmp/run.log",
      "/tmp/{repo}.log",
    ]) {
      assert.throws(
        () =>
          parsePublishConfig(
            table({ ...ok, report_path: path }),
            WHERE,
          ),
        /final path component/,
        `${path} must be refused`,
      );
    }
  });

  it("must not name {report} or climb with ..", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...ok, report_path: "/tmp/{report}-{ticket}.log" }),
          WHERE,
        ),
      /must not name \{report\}/,
    );
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...ok, report_path: "/tmp/../{ticket}.log" }),
          WHERE,
        ),
      /must not contain a "\.\." segment/,
    );
  });

  it("validates its placeholders like an argv element", () => {
    assert.throws(
      () =>
        parsePublishConfig(
          table({ ...ok, report_path: "/tmp/{nope}-{ticket}.log" }),
          WHERE,
        ),
      /undeclared placeholder/,
    );
  });
});

describe("publish config: substitution bounds", () => {
  it("refuses an element longer than the limit after substitution", () => {
    const long = "x".repeat(3_000);
    assert.throws(
      () =>
        fillPublishArgv(["./gate", "--branch={branch}{branch}"], values({ branch: long })),
      /longer than 4096 bytes after substitution/,
    );
  });

  it("refuses a value over the element limit before substituting it", () => {
    const huge = "x".repeat(5_000);
    assert.throws(
      () => fillPublishArgv(["./gate", "--branch={branch}"], values({ branch: huge })),
      /placeholder \{branch\} is longer than 4096 bytes/,
    );
  });

  it("refuses a value carrying a control character", () => {
    assert.throws(
      () => fillPublishArgv(["./gate", "--issue={issue}"], values({ issue: "BIT-1\u0000" })),
      /placeholder \{issue\} contains a control character/,
    );
  });

  it("refuses an undeclared placeholder in a template that skipped the loader", () => {
    assert.throws(
      () =>
        fillPublishArgv(
          ["./gate", "{custom}"],
          { ...values(), custom: "x" } as unknown as PublishValues,
        ),
      /placeholder \{custom\} is not declared/,
    );
  });

  it("refuses env ahead of a shell that a value supplied", () => {
    assert.throws(
      () => fillPublishArgv(["./gate", "env", "{branch}"], values({ branch: "sh" })),
      /runs env ahead of a shell after substitution/,
    );
  });

  it("refuses a report path that a value gives a .. segment", () => {
    const config: PublishConfig = {
      preGate: ["./pre-gate"],
      gate: ["./gate"],
      reportPath: "/tmp/reports/{issue}/{ticket}.log",
      gateTimeoutMs: 600_000,
      ticketTtlMs: 3_600_000,
    };
    assert.throws(
      () => publishReportPathFor(config, values({ issue: ".." })),
      /would contain "\.\." after substitution/,
    );
  });

  it("re-checks argv[0] after substitution", () => {
    // A template that never went through the loader still cannot turn into a
    // shell once the values are in.
    assert.throws(
      () => fillPublishArgv(["{repo}"], values({ repo: "sh" })),
      /shell or a text-evaluating runtime/,
    );
  });
});

describe("publish config: substitution bounds the whole argv", () => {
  it("refuses an argv over the total limit after substitution", () => {
    const many = Array.from({ length: 8 }, (_, index) => `--a${index}={repo}`);
    const big = "x".repeat(1_200);
    assert.throws(
      () => fillPublishArgv(many, values({ repo: big })),
      /over 8192 bytes after substitution/,
    );
  });
});
