// The `codex-chatgpt-login` task's shell guards, run through `/bin/sh` against
// fake `node` and `deno` executables. The committed task strings themselves
// are checked in `deno-tasks.test.ts`. Each child
// inherits this process's environment (Deno.Command does unless `clearEnv` is
// set), so a case names only the variables it overrides and the test itself
// needs no env grant.
import {
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";

describe("runtime lifecycle commands", () => {
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
