import { beforeEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";

const state = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  createdSessions: [] as Array<Record<string, unknown>>,
  updatedSessions: [] as Array<Record<string, unknown>>,
  nextId: 0,
  failCreateSession: false,
  failUpdateSession: false,
  failEventType: undefined as string | undefined,
  sessionExists: true,
  sessionWorkspace: undefined as string | null | undefined,
}));

vi.mock("./utils", () => ({
  generateULID: () => `01ACP${String(++state.nextId).padStart(21, "0")}`,
  generateTraceId: () => "trace-acp",
  generateSpanId: () => `span-${++state.nextId}`,
  writeEvent: (event: Record<string, unknown>) => {
    if (event.event_type === state.failEventType) {
      return Promise.reject(new Error(`failed ${state.failEventType}`));
    }
    state.events.push(event);
    return Promise.resolve();
  },
}));

vi.mock("./sessions", () => ({
  buildWorkbenchSessionSlug: (sessionId: string) => `workbench-${sessionId}`,
  buildWorkbenchSessionContent: (input: Record<string, unknown>) =>
    String(input.receipt ?? "# Workbench Session"),
  createWorkbenchSession: (input: Record<string, unknown>) => {
    state.createdSessions.push(input);
    if (state.failCreateSession) {
      return Promise.reject(new Error("failed session creation"));
    }
    return Promise.resolve();
  },
  fetchWorkbenchSessionWorkspaceRecord: () =>
    Promise.resolve({
      exists: state.sessionExists,
      workspace: state.sessionExists
        ? state.sessionWorkspace === undefined
          ? Deno.cwd()
          : state.sessionWorkspace
        : null,
    }),
  updateWorkbenchSession: (input: Record<string, unknown>) => {
    state.updatedSessions.push(input);
    if (state.failUpdateSession) {
      return Promise.reject(new Error("failed session update"));
    }
    return Promise.resolve();
  },
}));

import {
  codexChatGptProfile,
  fixtureProfile,
  runExternalAgentWorkbenchRuntime,
  verifiedRouteFacts,
} from "./external-agent-runtime";
import { AcpSessionUpdateLimitError } from "./acp-client";
import { summarizeError } from "./turn-contract";

describe("runExternalAgentWorkbenchRuntime", () => {
  test("leaves the fixture prompt timeout at the generic ACP default", () => {
    expect(fixtureProfile(Deno.cwd()).promptTimeoutMs).toBeUndefined();
  });

  test("exposes the contained session-update ceiling diagnostic at the runtime boundary", async () => {
    let thrown: unknown;
    try {
      await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "bounded update stream",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
      }, {
        runAgent: () => Promise.reject(new AcpSessionUpdateLimitError()),
      });
    } catch (error) {
      thrown = error;
    }
    expect(summarizeError(thrown)).toBe(
      "ACP agent exceeded the session-update limit",
    );
  });

  test("does not promote adapter authentication into route facts", () => {
    const profile = {
      ...fixtureProfile(Deno.cwd()),
      accessRoute: "subscription_oauth" as const,
      costBasis: "subscription_quota" as const,
      requiredAuthentication: "chat-gpt" as const,
    };
    expect(verifiedRouteFacts(profile, {
      source: "agent_auth_status",
      authenticationType: "chat-gpt",
    })).toEqual({ costBasis: "unknown" });
    expect(verifiedRouteFacts(profile, {
      source: "profile_declared",
      authenticationType: "chat-gpt",
    })).toEqual({
      accessRoute: "subscription_oauth",
      costBasis: "subscription_quota",
    });
  });

  beforeEach(() => {
    state.events.length = 0;
    state.createdSessions.length = 0;
    state.updatedSessions.length = 0;
    state.nextId = 0;
    state.failCreateSession = false;
    state.failUpdateSession = false;
    state.failEventType = undefined;
    state.sessionExists = true;
    state.sessionWorkspace = undefined;
  });

  test("closes cancellation registration when rejecting a remote caller", async () => {
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      authContext: {
        transport: "remote",
        authnStatus: "authenticated",
        authnMechanism: "api_key",
        authnIssuerRef: "test",
        authzBasis: "policy",
      },
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toThrow("unavailable to remote callers");
    expect(cancellationClosed).toBe(1);
  });

  test("does not claim subscription route evidence when authentication never verifies", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "cancel during authentication",
      routingOptions: {},
      runner: { kind: "acp", profile: "codex-chatgpt" },
      workspaceRoot: Deno.cwd(),
      trustWorkspaceInstructions: true,
    }, {
      resolveProfile: (_profile, workspace) => ({
        slug: "codex-chatgpt",
        command: Deno.execPath(),
        args: [],
        environment: {},
        workspace,
        transport: "local_stdio",
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        requiredAuthentication: "chat-gpt",
      }),
      runAgent: () =>
        Promise.resolve({
          text: "",
          stopReason: "aborted",
          capabilities: [],
          routeEvidence: {
            source: "profile_declared",
            authenticationType: "chat-gpt",
          },
          elapsedMs: 5,
        }),
    });
    expect(result.runner).toMatchObject({
      costBasis: "unknown",
      evidence: { source: "acp", innerState: "opaque" },
    });
    expect(result.runner).not.toHaveProperty("accessRoute");
    expect(result.runner.evidence).not.toHaveProperty("routeSource");
    expect(result.receipt).toContain("Access route: unverified");
    expect(result.receipt).toContain("Cost basis: unknown");
    expect(result.receipt).not.toContain("subscription_oauth");
    expect(result.receipt).not.toContain("subscription_quota");

    expect(state.events.some((event) => event.event_type === "runner_selected"))
      .toBe(false);
    const response = state.events.find((event) =>
      event.event_type === "agent_response"
    );
    expect(response).toMatchObject({
      runner_access_route: null,
      runner_cost_basis: "unknown",
      runner_route_source: null,
      runner_auth_type: null,
    });
  });

  test("rejects an unknown supplied session before writing events", async () => {
    state.sessionExists = false;
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01UNKNOWNSESSION00000000000",
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toThrow("Workbench session not found");
    expect(cancellationClosed).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.createdSessions).toEqual([]);
  });

  test("keeps a resumed external turn on its persisted workspace", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01EXISTINGSESSION0000000000",
      workspaceRoot: "/private/tmp",
    });
    expect(result.text).toContain(`cwd=${Deno.cwd()}`);
    expect(result.text).not.toContain("cwd=/private/tmp");
  });

  test("rejects a resumed session without persisted workspace evidence", async () => {
    state.sessionWorkspace = null;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01LEGACYSESSION000000000000",
      workspaceRoot: "/private/tmp",
    })).rejects.toThrow("no persisted workspace");
    expect(state.events).toEqual([]);
  });

  test("does not read or forward an ambient Deno cache path", () => {
    const original = Deno.env.get("DENO_DIR");
    try {
      Deno.env.set("DENO_DIR", "/tmp/acp-declared-deno-dir");
      expect(fixtureProfile(Deno.cwd()).environment).not.toHaveProperty(
        "DENO_DIR",
      );
      expect(fixtureProfile(Deno.cwd()).args).toEqual(
        expect.arrayContaining([
          "--node-modules-dir=manual",
          expect.stringMatching(/^--config=\/.*\/prototype\/deno\.json$/),
        ]),
      );
    } finally {
      if (original === undefined) Deno.env.delete("DENO_DIR");
      else Deno.env.set("DENO_DIR", original);
    }
  });

  test("builds a pinned, isolated Codex ChatGPT profile without ambient secrets", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const packageRoot = `${root}/node_modules/@agentclientprotocol/codex-acp`;
    const home = `${root}/operator-home`;
    await Deno.mkdir(home);
    await Deno.mkdir(`${packageRoot}/dist`, { recursive: true });
    await Deno.writeTextFile(
      `${packageRoot}/package.json`,
      JSON.stringify({ version: "1.1.10" }),
    );
    await Deno.writeTextFile(`${packageRoot}/dist/index.js`, "");
    const codexPath = `${root}/node_modules/@openai/codex/bin/codex.js`;
    await Deno.mkdir(`${root}/node_modules/@openai/codex/bin`, {
      recursive: true,
    });
    await Deno.writeTextFile(codexPath, "");
    await Deno.chmod(codexPath, 0o700);
    const nodePath = `${root}/node`;
    await Deno.writeTextFile(
      nodePath,
      `#!/bin/sh\nprintf '%s\\n' '{"execPath":"${nodePath}","release":"node"}'\n`,
    );
    await Deno.chmod(nodePath, 0o700);
    const ambientNames = [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "DEFAULT_AUTH_REQUEST",
      "MODEL_PROVIDER",
      "APP_SERVER_LOGS",
      "SSH_AUTH_SOCK",
    ];
    const originals = new Map(
      ambientNames.map((name) => [name, Deno.env.get(name)]),
    );
    for (const name of ambientNames) Deno.env.set(name, "must-not-cross");
    try {
      const profile = await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: root,
        nodePath,
      });
      expect(profile).toMatchObject({
        slug: "codex-chatgpt",
        command: nodePath,
        args: [await Deno.realPath(`${packageRoot}/dist/index.js`)],
        accessRoute: "subscription_oauth",
        costBasis: "subscription_quota",
        requiredAuthentication: "chat-gpt",
        promptTimeoutMs: 30 * 60_000,
        sessionUpdatePolicy: "long_running",
        toolchainDirectoryCount: 0,
        environment: {
          HOME: `${home}/.dyfj/runner-homes/codex-chatgpt/home`,
          CODEX_HOME: `${home}/.dyfj/runner-homes/codex-chatgpt/home/.codex`,
          CARGO_HOME: `${home}/.dyfj/runner-homes/codex-chatgpt/home/.cargo`,
          CODEX_PATH: await Deno.realPath(codexPath),
          NO_BROWSER: "1",
          INITIAL_AGENT_MODE: "read-only",
          PATH: `${home}/.dyfj/runner-homes/codex-chatgpt/bin:/usr/bin:/bin`,
        },
      });
      for (const name of ambientNames) {
        expect(profile.environment).not.toHaveProperty(name);
      }
      const privateDirectories = [
        `${home}/.dyfj/runner-homes/codex-chatgpt`,
        `${home}/.dyfj/runner-homes/codex-chatgpt/bin`,
        `${home}/.dyfj/runner-homes/codex-chatgpt/home`,
        `${home}/.dyfj/runner-homes/codex-chatgpt/home/.codex`,
        `${home}/.dyfj/runner-homes/codex-chatgpt/home/.cargo`,
      ];
      for (const directory of privateDirectories) {
        expect((await Deno.stat(directory)).mode! & 0o777).toBe(0o700);
      }
      const nodeShim = `${home}/.dyfj/runner-homes/codex-chatgpt/bin/node`;
      expect((await Deno.stat(nodeShim)).mode! & 0o777).toBe(0o700);
      expect(await Deno.readTextFile(nodeShim)).toBe(
        `#!/bin/sh\nexec '${nodePath}' "$@"\n`,
      );
      const zshProfile =
        `${home}/.dyfj/runner-homes/codex-chatgpt/home/.zprofile`;
      expect((await Deno.stat(zshProfile)).mode! & 0o777).toBe(0o600);
      expect(await Deno.readTextFile(zshProfile)).toBe(
        `export PATH='${home}/.dyfj/runner-homes/codex-chatgpt/bin:/usr/bin:/bin'\n`,
      );
      const bashProfile =
        `${home}/.dyfj/runner-homes/codex-chatgpt/home/.bash_profile`;
      expect((await Deno.stat(bashProfile)).mode! & 0o777).toBe(0o600);
      expect(await Deno.readTextFile(bashProfile)).toBe(
        `export PATH='${home}/.dyfj/runner-homes/codex-chatgpt/bin:/usr/bin:/bin'\n`,
      );
    } finally {
      for (const [name, value] of originals) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  });

  test("projects an explicit toolchain and Rustup home without inheriting ambient PATH", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const toolchain = `${home}/toolchain-bin`;
    const rustupHome = `${home}/rustup-home`;
    await Deno.mkdir(toolchain, { mode: 0o700 });
    await Deno.mkdir(rustupHome, { mode: 0o700 });
    const nodePath = `${home}/node`;
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    const ambient = Deno.env.get("PATH");
    let profile: Awaited<ReturnType<typeof codexChatGptProfile>>;
    try {
      Deno.env.set("PATH", `${home}/ambient-bin`);
      profile = await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
        toolchainPath: toolchain,
        rustupHome,
      });
    } finally {
      if (ambient === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", ambient);
    }
    try {
      expect(profile.environment.PATH).toBe(
        `${home}/.dyfj/runner-homes/codex-chatgpt/bin:${await Deno.realPath(
          toolchain,
        )}:/usr/bin:/bin`,
      );
      expect(profile.environment.PATH).not.toContain("ambient-bin");
      expect(profile.environment.RUSTUP_HOME).toBe(
        await Deno.realPath(rustupHome),
      );
      expect(profile.environment.CARGO_HOME).toBe(
        `${home}/.dyfj/runner-homes/codex-chatgpt/home/.cargo`,
      );
      expect(
        (await Deno.stat(profile.environment.CARGO_HOME)).mode! & 0o777,
      ).toBe(0o700);
      expect(profile.toolchainDirectoryCount).toBe(2);
      if (Deno.build.os === "darwin") {
        for (const shell of ["/bin/zsh", "/bin/bash"]) {
          const loginShell = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              `--allow-run=${shell}`,
              `data:text/typescript,${encodeURIComponent(
                `const output = await new Deno.Command(${JSON.stringify(shell)}, {
  args: ["-lc", ${JSON.stringify(
                  'printf "%s\\n" "$PATH"; command -v node; if command -v brew >/dev/null; then exit 23; fi',
                )}],
  stdout: "piped",
  stderr: "piped",
}).output();
await Deno.stdout.write(output.stdout);
await Deno.stderr.write(output.stderr);
Deno.exit(output.code);`,
              )}`,
            ],
            env: profile.environment,
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
          }).output();
          expect(loginShell.code).toBe(0);
          expect(
            new TextDecoder().decode(loginShell.stdout).trim().split("\n"),
          ).toEqual([
            profile.environment.PATH,
            `${home}/.dyfj/runner-homes/codex-chatgpt/bin/node`,
          ]);
        }
      }
      const sharedDirectoryProfile = await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
        toolchainPath: toolchain,
        rustupHome: toolchain,
      });
      expect(sharedDirectoryProfile.toolchainDirectoryCount).toBe(1);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects invalid toolchain directory authority with fixed diagnostics", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${home}/toolchain-file`;
    const unsafe = `${home}/unsafe`;
    const unsearchable = `${home}/unsearchable`;
    const link = `${home}/toolchain-link`;
    const nodePath = `${home}/node`;
    await Deno.writeTextFile(file, "not a directory\n");
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    await Deno.mkdir(unsafe);
    await Deno.chmod(unsafe, 0o777);
    await Deno.mkdir(unsearchable);
    await Deno.chmod(unsearchable, 0o600);
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", home, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      for (
        const toolchainPath of [
          "relative",
          `${home}/comma,dir`,
          `${home}/colon:dir`,
        ]
      ) {
        await expect(codexChatGptProfile(Deno.cwd(), {
          home,
          prototypeRoot: Deno.cwd(),
          nodePath,
          toolchainPath,
        })).rejects.toThrow(
          "Codex ACP requires an absolute, delimiter-safe toolchain directory",
        );
      }
      for (
        const toolchainPath of [
          `${home}/missing`,
          "/",
          "///",
          file,
          unsafe,
          unsearchable,
          link,
          `${link}/`,
        ]
      ) {
        await expect(codexChatGptProfile(Deno.cwd(), {
          home,
          prototypeRoot: Deno.cwd(),
          nodePath,
          toolchainPath,
        })).rejects.toThrow("Codex ACP toolchain directory is unavailable");
      }
      await expect(Deno.lstat(`${home}/.dyfj`)).rejects.toThrow();
    } finally {
      await Deno.chmod(unsafe, 0o700);
      await Deno.chmod(unsearchable, 0o700);
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects invalid Rustup home authority with fixed diagnostics", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${home}/rustup-file`;
    const unsafe = `${home}/unsafe`;
    const unsearchable = `${home}/unsearchable`;
    const unreadable = `${home}/unreadable`;
    const unwritable = `${home}/unwritable`;
    const link = `${home}/rustup-link`;
    const nodePath = `${home}/node`;
    await Deno.writeTextFile(file, "not a directory\n");
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    await Deno.mkdir(unsafe);
    await Deno.chmod(unsafe, 0o777);
    await Deno.mkdir(unsearchable);
    await Deno.chmod(unsearchable, 0o600);
    await Deno.mkdir(unreadable);
    await Deno.chmod(unreadable, 0o300);
    await Deno.mkdir(unwritable);
    await Deno.chmod(unwritable, 0o500);
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", home, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      for (
        const rustupHome of [
          "relative",
          `${home}/comma,dir`,
          `${home}/colon:dir`,
        ]
      ) {
        await expect(codexChatGptProfile(Deno.cwd(), {
          home,
          prototypeRoot: Deno.cwd(),
          nodePath,
          rustupHome,
        })).rejects.toThrow(
          "Codex ACP requires an absolute, delimiter-safe Rustup home directory",
        );
      }
      for (
        const rustupHome of [
          `${home}/missing`,
          "/",
          "///",
          file,
          unsafe,
          unsearchable,
          unreadable,
          unwritable,
          link,
          `${link}/`,
        ]
      ) {
        await expect(codexChatGptProfile(Deno.cwd(), {
          home,
          prototypeRoot: Deno.cwd(),
          nodePath,
          rustupHome,
        })).rejects.toThrow("Codex ACP Rustup home directory is unavailable");
      }
      await expect(Deno.lstat(`${home}/.dyfj`)).rejects.toThrow();
    } finally {
      await Deno.chmod(unsafe, 0o700);
      await Deno.chmod(unsearchable, 0o700);
      await Deno.chmod(unreadable, 0o700);
      await Deno.chmod(unwritable, 0o700);
      await Deno.remove(home, { recursive: true });
    }
  });

  test("resolves the locked Codex executable from managed node_modules", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const nodePath = await Deno.makeTempFile({ dir: Deno.cwd() });
    await Deno.writeTextFile(
      nodePath,
      `#!/bin/sh\nprintf '%s\\n' '{"execPath":"${nodePath}","release":"node"}'\n`,
    );
    await Deno.chmod(nodePath, 0o700);
    try {
      const profile = await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
      });
      const codexPath = profile.environment.CODEX_PATH;
      expect(codexPath).toBeDefined();
      expect((await Deno.stat(codexPath!)).mode! & 0o111).not.toBe(0);
      const packageMetadata = JSON.parse(
        await Deno.readTextFile(
          join(dirname(codexPath!), "..", "package.json"),
        ),
      );
      expect(packageMetadata.version).toBe("0.146.1");
    } finally {
      await Deno.remove(nodePath);
      await Deno.remove(home, { recursive: true });
    }
  });

  test("bounds adapter package metadata before parsing it", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const packageRoot = `${root}/node_modules/@agentclientprotocol/codex-acp`;
    const home = `${root}/operator-home`;
    await Deno.mkdir(home);
    await Deno.mkdir(packageRoot, { recursive: true });
    await Deno.writeTextFile(
      `${packageRoot}/package.json`,
      "x".repeat(65_537),
    );
    try {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: root,
        nodePath: Deno.execPath(),
      })).rejects.toThrow("Pinned Codex ACP package is unavailable");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("does not claim to attest the operator-authorized executable", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const target = `${home}/not-node-target`;
    const executable = `${home}/not-node`;
    await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(target, 0o700);
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, executable],
    }).output();
    expect(linked.success).toBe(true);
    try {
      const profile = await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath: executable,
      });
      expect(profile.command).toBe(executable);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects executable authority outside the explicit path contract", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const nonExecutable = `${home}/not-executable`;
    await Deno.writeTextFile(nonExecutable, "not executable\n");
    try {
      for (
        const nodePath of [
          "node",
          `${home}/node,unsafe`,
          `${home}/node:unsafe`,
        ]
      ) {
        await expect(codexChatGptProfile(Deno.cwd(), {
          home,
          prototypeRoot: Deno.cwd(),
          nodePath,
        })).rejects.toThrow(
          "Codex ACP requires an absolute, delimiter-safe DYFJ_NODE_PATH",
        );
      }
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath: nonExecutable,
      })).rejects.toThrow("Codex ACP executable is unavailable");
      await expect(Deno.lstat(`${home}/.dyfj`)).rejects.toThrow();
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects an operator home that Deno path grants cannot represent", async () => {
    for (const home of ["/tmp/operator,home", "/tmp/operator:home"]) {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath: Deno.execPath(),
      })).rejects.toThrow("absolute, delimiter-safe operator home");
    }
  });

  test("rejects a group- or world-writable operator home", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    await Deno.chmod(home, 0o777);
    try {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath: Deno.execPath(),
      })).rejects.toThrow("operator home is unavailable");
      expect((await Deno.stat(home)).mode! & 0o777).toBe(0o777);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects a symlinked runner-home ancestor before writing through it", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const home = `${root}/operator-home`;
    const target = `${root}/redirect-target`;
    const nodePath = `${root}/node`;
    await Deno.mkdir(home);
    await Deno.mkdir(target);
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, `${home}/.dyfj`],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
      })).rejects.toThrow("runner home is unavailable");
      await expect(Deno.stat(`${target}/runner-homes`)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("preserves modes on existing parent directories", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const dyfjRoot = `${home}/.dyfj`;
    const runnerHomes = `${dyfjRoot}/runner-homes`;
    const nodePath = `${home}/node`;
    await Deno.mkdir(dyfjRoot, { mode: 0o755 });
    await Deno.mkdir(runnerHomes, { mode: 0o750 });
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    await Deno.chmod(dyfjRoot, 0o755);
    await Deno.chmod(runnerHomes, 0o750);
    try {
      await codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
      });
      expect((await Deno.stat(dyfjRoot)).mode! & 0o777).toBe(0o755);
      expect((await Deno.stat(runnerHomes)).mode! & 0o777).toBe(0o750);
      expect(
        (await Deno.stat(`${runnerHomes}/codex-chatgpt`)).mode! & 0o777,
      ).toBe(0o700);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects writable existing runner-home ancestors", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const dyfjRoot = `${home}/.dyfj`;
    const nodePath = `${home}/node`;
    await Deno.mkdir(dyfjRoot, { mode: 0o777 });
    await Deno.chmod(dyfjRoot, 0o777);
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    try {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
      })).rejects.toThrow("runner home is unavailable");
      expect((await Deno.stat(dyfjRoot)).mode! & 0o777).toBe(0o777);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects a writable pre-existing Codex home", async () => {
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const codexHome = `${home}/.dyfj/runner-homes/codex-chatgpt/home/.codex`;
    const nodePath = `${home}/node`;
    await Deno.mkdir(codexHome, { recursive: true, mode: 0o700 });
    await Deno.chmod(codexHome, 0o777);
    await Deno.writeTextFile(`${codexHome}/config.toml`, "hostile = true\n");
    await Deno.writeTextFile(nodePath, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(nodePath, 0o700);
    try {
      await expect(codexChatGptProfile(Deno.cwd(), {
        home,
        prototypeRoot: Deno.cwd(),
        nodePath,
      })).rejects.toThrow("runner home is unavailable");
      expect((await Deno.stat(codexHome)).mode! & 0o777).toBe(0o777);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("runs the fixture from a workspace outside the prototype checkout", async () => {
    const workspace = await Deno.makeTempDir();
    try {
      const resolvedWorkspace = await Deno.realPath(workspace);
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: workspace,
      });
      expect(result.text).toContain(`cwd=${resolvedWorkspace}`);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  test("rejects an oversized prompt before writing session state", async () => {
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "x".repeat(60_001),
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toMatchObject({ phase: "prompt" });
    expect(cancellationClosed).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.createdSessions).toEqual([]);
  });

  test("finalizes a session-creation failure through the outer lifecycle", async () => {
    state.failCreateSession = true;
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed session creation");
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "error",
      "session_end",
    ]);
  });

  test("finalizes a runner-selection write failure", async () => {
    state.failEventType = "runner_selected";
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed runner_selected");
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "error",
      "session_end",
    ]);
  });

  test("keeps a successful turn authoritative when its session projection fails", async () => {
    state.failUpdateSession = true;
    const runtimeEvents: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
        onRuntimeEvent: (event) => {
          runtimeEvents.push(event.type);
        },
      });
      expect(result.stopReason).toBe("stop");
      expect(result.receipt).toContain("Session projection: update skipped");
      expect(warn).toHaveBeenCalledWith("Session projection update skipped");
      expect(runtimeEvents).toEqual([
        "sessionStart",
        "inputReceived",
        "turnCompleted",
      ]);
      expect(state.events.map((event) => event.event_type)).toEqual([
        "session_start",
        "runner_selected",
        "agent_response",
        "session_end",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("preserves an agent failure when its error event cannot be written", async () => {
    state.failEventType = "error";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_MALFORMED",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("ACP agent sent malformed protocol data");
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "session_end",
    ]);
  });

  test("does not project success when the response event fails", async () => {
    state.failEventType = "agent_response";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed agent_response");
    expect(state.updatedSessions).toEqual([
      expect.objectContaining({ content: "External-agent turn failed" }),
    ]);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "error",
      "session_end",
    ]);
  });

  test("does not rewrite durable success when runtime observer delivery fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
        onRuntimeEvent: (event) => {
          if (event.type === "turnCompleted") {
            throw new Error("disconnected observer");
          }
        },
      });
      expect(result.stopReason).toBe("stop");
      expect(state.events.map((event) => event.event_type)).toEqual([
        "session_start",
        "runner_selected",
        "agent_response",
        "session_end",
      ]);
      expect(warn).toHaveBeenCalledWith("Runtime event delivery skipped");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not project success when the durable session-end write fails", async () => {
    state.failEventType = "session_end";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed session_end");
    expect(state.updatedSessions).toEqual([
      expect.objectContaining({ content: "External-agent turn failed" }),
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "agent_response",
      "error",
    ]);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
  });

  test("retains ACP stop semantics and emits matching lifecycle events", async () => {
    const lengthEvents: string[] = [];
    const length = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_MAX_TOKENS",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        lengthEvents.push(event.type);
      },
    });
    expect(length.stopReason).toBe("length");
    expect(length.runner.externalStopReason).toBe("max_tokens");
    expect(lengthEvents.at(-1)).toBe("turnCompleted");

    const refusalEvents: string[] = [];
    const refusal = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_REFUSAL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        refusalEvents.push(event.type);
      },
    });
    expect(refusal.stopReason).toBe("error");
    expect(refusal.runner.externalStopReason).toBe("refusal");
    expect(refusalEvents.at(-1)).toBe("turnFailed");
  });

  test("persists typed outer ACP evidence without native provider accounting", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
    });

    expect(result.text).toBe(`first|cwd=${Deno.cwd()}|last`);
    expect(result.runner).toMatchObject({
      kind: "external_agent",
      profile: "fixture",
      protocol: "acp",
      protocolVersion: 1,
      externalStopReason: "end_turn",
      transport: "local_stdio",
      accessRoute: "local_sidecar",
      costBasis: "local_free",
      evidence: {
        source: "acp",
        innerState: "opaque",
        toolchainDirectoryCount: 0,
        routeSource: "profile_declared",
      },
    });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("tokens");
    expect(result).not.toHaveProperty("cost");
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "agent_response",
      "session_end",
    ]);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "model_response",
    );
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "provider_call",
    );
    expect(state.events[2]).toMatchObject({
      runner_kind: "external_agent",
      runner_profile: "fixture",
      runner_protocol: "acp",
      runner_protocol_version: "1",
      runner_stop_reason: "end_turn",
      runner_external_session_id: "fixture-1",
      runner_transport: "local_stdio",
      runner_access_route: "local_sidecar",
      runner_cost_basis: "local_free",
      runner_evidence_scope: "outer_only",
      content: result.text,
    });
  });

  test("keeps a completed turn authoritative when cancellation cleanup throws", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => {
        throw new Error("cleanup failed");
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(state.events.map((event) => event.event_type)).toContain(
      "agent_response",
    );
  });

  test("records fail-closed permission denial", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_PERMISSION",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
    });

    expect(result.text).toBe("denied");
    expect(
      state.events.find((event) => event.event_type === "agent_permission"),
    )
      .toMatchObject({
        permission_verdict: "denied",
        principal_id: "dyfj-workbench",
        principal_type: "service",
        action: "enforce",
        runner_kind: "external_agent",
        runner_protocol: "acp",
      });
  });

  test("does not project success when a permission verdict cannot be recorded", async () => {
    state.failEventType = "agent_permission";
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_PERMISSION_EARLY_TERMINAL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      confirmExternalAgentPermission: async () => "approve",
    })).rejects.toMatchObject({ phase: "permission" });
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "agent_response",
    );
  });

  test("preserves partial cancellation and permits the next outer turn", async () => {
    const controller = new AbortController();
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    const first = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_CANCEL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      abortSignal: controller.signal,
      onTextDelta: () => controller.abort(),
      onCancellationClosed: () => {
        cancellationClosed += 1;
      },
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    });
    expect(first).toMatchObject({ text: "partial\n", stopReason: "aborted" });
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnAborted",
    ]);

    const second = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stopReason).toBe("stop");
    expect(second.text).toContain("first|");
  });
});
