// The `deno.json` task strings: the committed grants of the generic server
// and login tasks, and the `codex-chatgpt-login` task's shell guards, run
// through `/bin/sh` against fake `node` and `deno` executables. Each child
// inherits this process's environment (Deno.Command does unless `clearEnv` is
// set), so a case names only the variables it overrides and the test itself
// needs no env grant.
import {
  assertArrayIncludes,
  assertFalse,
  assertMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";

describe("runtime lifecycle commands", () => {
  it("generic server tasks remain cross-platform and runner-neutral", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, {
        env?: string[] | boolean;
        read?: string[] | boolean;
        run?: string[] | boolean;
        sys?: string[] | boolean;
      }>;
    };
    const tasks = parsed.tasks;
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-read=".,$node_path,$HOME,$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-write="$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-run="bash,$node_path"',
    );
    assertStringIncludes(tasks["codex-chatgpt-login"], "--allow-sys=uid");
    assertMatch(tasks["serve-unix"], /^deno run --no-prompt /);
    assertFalse(tasks["serve-unix"].includes("/bin/sh"));
    assertFalse(tasks["serve-unix"].includes("DYFJ_NODE_PATH"));
    assertArrayIncludes(parsed.permissions["serve-unix"].run as string[], [
      "/bin/kill",
    ]);
    assertArrayIncludes(parsed.permissions["serve-unix"].sys as string[], [
      "uid",
    ]);
    assertArrayIncludes(parsed.permissions["test"].run as string[], [
      "/bin/bash",
    ]);
    const vitestRunner = await Deno.readTextFile("scripts/run-vitest.ts");
    assertStringIncludes(vitestRunner, "const run = [");
    assertStringIncludes(vitestRunner, "denoExecutable,");
    assertStringIncludes(vitestRunner, "`--allow-run=${run}`");
    assertFalse(
      vitestRunner.includes(
        "--allow-run=bash,/bin/bash,deno,/bin/kill,/bin/sh",
      ),
    );
    assertArrayIncludes(parsed.permissions["serve-unix"].env as string[], [
      "NODE_V8_COVERAGE",
    ]);
    assertStrictEquals(parsed.permissions["serve-unix"].read, true);
  });

  it("codex-chatgpt-login fails clearly when Node is unavailable", async () => {
    const dir = await Deno.makeTempDir({ prefix: "dyfj-deno-tasks-" });
    const fakeDeno = `${dir}/deno`;
    try {
      await Deno.writeTextFile(
        fakeDeno,
        "#!/bin/sh\necho 'unexpected deno invocation' >&2\nexit 99\n",
      );
      await Deno.chmod(fakeDeno, 0o700);
      const raw = await Deno.readTextFile("deno.json");
      const tasks =
        (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
      for (
        const env of [
          { DYFJ_NODE_PATH: "", PATH: dir },
          { DYFJ_NODE_PATH: dir, PATH: "/usr/bin:/bin" },
        ]
      ) {
        const output = await new Deno.Command("/bin/sh", {
          args: ["-c", tasks["codex-chatgpt-login"]],
          cwd: Deno.cwd(),
          env,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const stderr = new TextDecoder().decode(output.stderr);
        assertStrictEquals(output.code, 1);
        assertStringIncludes(
          stderr,
          "dyfj: codex-chatgpt-login requires an absolute operator-authorized executable on PATH or in DYFJ_NODE_PATH",
        );
        assertFalse(stderr.includes("unexpected deno invocation"));
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("codex-chatgpt-login rejects an unsafe home before Deno starts", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const tasks = (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
    for (const home of ["", "..", "/tmp/dyfj,home", "/tmp/dyfj:home"]) {
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", tasks["codex-chatgpt-login"]],
        cwd: Deno.cwd(),
        env: { HOME: home },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertStrictEquals(output.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(output.stderr),
        home.startsWith("/tmp/dyfj")
          ? "codex-chatgpt-login home path contains an unsupported delimiter"
          : "codex-chatgpt-login requires an absolute home path",
      );
    }
  });

  it("codex-chatgpt-login does not read or project the optional toolchain", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const tasks = (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
    const home = await Deno.makeTempDir({ prefix: "dyfj-deno-tasks-" });
    const fakeNode = `${home}/node`;
    const marker = [
      home,
      ".dyfj/runner-homes/codex-chatgpt",
      "home",
      "login-args",
    ].join("/");
    try {
      await Deno.writeTextFile(
        fakeNode,
        `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' '{"execPath":"${fakeNode}","release":"node"}'
  exit 0
fi
printf '%s\\n' "$*" > "$HOME/login-args"
`,
      );
      await Deno.chmod(fakeNode, 0o700);
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", tasks["codex-chatgpt-login"]],
        cwd: Deno.cwd(),
        env: {
          HOME: home,
          DYFJ_NODE_PATH: fakeNode,
          DYFJ_CODEX_TOOLCHAIN_PATH: `${home}/must-not-be-read`,
          DYFJ_CODEX_RUSTUP_HOME: `${home}/must-not-be-read-either`,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(output.stderr);
      assertStrictEquals(output.code, 0);
      assertFalse(
        stderr.includes('Requires env access to "DYFJ_CODEX_TOOLCHAIN_PATH"'),
      );
      assertFalse(
        stderr.includes('Requires env access to "DYFJ_CODEX_RUSTUP_HOME"'),
      );
      assertStrictEquals(
        (await Deno.readTextFile(marker)).trim().endsWith(" login"),
        true,
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});
