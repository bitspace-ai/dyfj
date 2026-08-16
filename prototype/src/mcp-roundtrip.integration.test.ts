import { DyfjMcpClient, type DyfjMcpClientOptions } from "./mcp-client.ts";

function requiredFixtureEnv(
  name: string,
  read: (name: string) => string | undefined = Deno.env.get,
): string {
  const value = read(name);
  if (value === undefined) {
    throw new Error(`missing required fixture environment variable: ${name}`);
  }
  return value;
}

function fixtureClientOptions(
  read: (name: string) => string | undefined = Deno.env.get,
): DyfjMcpClientOptions {
  return {
    serverExecutable: requiredFixtureEnv("DENO_BIN", read),
    serverScript: `${requiredFixtureEnv("DYFJ_ROOT", read)}/mcp/server.ts`,
    childEnv: {
      HOME: requiredFixtureEnv("HOME", read),
      DOLT_HOST: requiredFixtureEnv("DOLT_HOST", read),
      DOLT_PORT: requiredFixtureEnv("DOLT_PORT", read),
      DOLT_USER: requiredFixtureEnv("DOLT_USER", read),
      DOLT_PASSWORD: requiredFixtureEnv("DOLT_PASSWORD", read),
      DOLT_DATABASE: requiredFixtureEnv("DOLT_DATABASE", read),
    },
  };
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    assertIncludes(String(error), expected);
    return;
  }
  throw new Error(`expected function to throw ${expected}`);
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(value)} to include ${expected}`);
  }
}

function assertNotIncludes(value: string, expected: string): void {
  if (value.includes(expected)) {
    throw new Error(
      `expected ${JSON.stringify(value)} not to include ${expected}`,
    );
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`,
    );
  }
}

async function processExists(pid: number): Promise<boolean> {
  const output = await new Deno.Command("/bin/kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!await processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`MCP child ${pid} was not reaped`);
}

async function instrumentedFixtureClient(
  mode: "auto" | "legacy",
): Promise<
  { client: DyfjMcpClient; pidLog: string; cleanup: () => Promise<void> }
> {
  const tempDir = await Deno.makeTempDir({
    dir: requiredFixtureEnv("DYFJ_MCP_TEST_TEMP_DIR"),
    prefix: "mcp-child-",
  });
  const pidLog = `${tempDir}/pids`;
  const options = fixtureClientOptions();
  options.serverExecutable = `${
    requiredFixtureEnv("DYFJ_ROOT")
  }/scripts/mcp-child-wrapper.sh`;
  options.childEnv = {
    ...options.childEnv,
    DYFJ_MCP_PID_LOG: pidLog,
    DYFJ_REAL_DENO: requiredFixtureEnv("DENO_BIN"),
  };
  return {
    client: new DyfjMcpClient({ ...options, versionNegotiation: mode }),
    pidLog,
    cleanup: () => Deno.remove(tempDir, { recursive: true }),
  };
}

Deno.test(
  "modern production MCP session negotiates 2026-07-28 without legacy lifecycle messages",
  async () => {
    const fixture = await instrumentedFixtureClient("auto");
    const { client } = fixture;
    let pids: number[] = [];
    try {
      await client.connect();
      assertEquals(client.protocolEra, "modern");
      assertEquals(client.protocolVersion, "2026-07-28");
      const list = await client.listMemories();
      assertIncludes(list, "fixture_project_public");
      assertIncludes(list, "fixture_reference_client_safe");
      assertNotIncludes(list, "fixture_user_private");

      const publicMemory = await client.readMemory("fixture_project_public");
      assertIncludes(publicMemory, "public project content");
      const sessionMethods = client.sessionMethodEvidence;
      assertEquals(sessionMethods.includes("tools/call"), true);
      assertEquals(sessionMethods.includes("initialize"), false);
      assertEquals(sessionMethods.includes("notifications/initialized"), false);
      assertEquals(sessionMethods.includes("server/discover"), false);
      await client.readMemory("fixture_user_private").then(
        () => {
          throw new Error("private fixture row was exposed through MCP");
        },
        (error: unknown) => assertIncludes(String(error), "Memory not found"),
      );

      pids = (await Deno.readTextFile(fixture.pidLog)).trim().split("\n").map(
        Number,
      );
      assertEquals(pids.length, 2);
      await waitForProcessExit(pids[0]!);
      assertEquals(await processExists(pids[1]!), true);
    } finally {
      await client.disconnect();
      for (const pid of pids) await waitForProcessExit(pid);
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "deliberate legacy client reaches the dual-era production server with the same visibility",
  async () => {
    const fixture = await instrumentedFixtureClient("legacy");
    const { client } = fixture;
    let pids: number[] = [];
    try {
      await client.connect();
      assertEquals(client.protocolEra, "legacy");
      const list = await client.listMemories();
      assertIncludes(list, "fixture_project_public");
      assertIncludes(list, "fixture_reference_client_safe");
      assertNotIncludes(list, "fixture_user_private");
      const publicMemory = await client.readMemory("fixture_project_public");
      assertIncludes(publicMemory, "public project content");
      const sessionMethods = client.sessionMethodEvidence;
      assertEquals(sessionMethods.includes("initialize"), true);
      assertEquals(sessionMethods.includes("notifications/initialized"), true);
      assertEquals(sessionMethods.includes("tools/call"), true);
      await client.readMemory("fixture_user_private").then(
        () => {
          throw new Error("private fixture row was exposed through legacy MCP");
        },
        (error: unknown) => assertIncludes(String(error), "Memory not found"),
      );
      pids = (await Deno.readTextFile(fixture.pidLog)).trim().split("\n").map(
        Number,
      );
      assertEquals(pids.length, 1);
      assertEquals(await processExists(pids[0]!), true);
    } finally {
      await client.disconnect();
      for (const pid of pids) await waitForProcessExit(pid);
      await fixture.cleanup();
    }
  },
);

Deno.test("MCP round trip fails closed without fixture connection settings", () => {
  const fixtureEnvironment: Record<string, string> = {
    DENO_BIN: "/fixture/deno",
    DYFJ_ROOT: "/fixture/prototype",
    HOME: "/fixture/home",
    DOLT_PORT: "3306",
    DOLT_USER: "root",
    DOLT_PASSWORD: "",
    DOLT_DATABASE: "fixture",
  };
  assertThrows(
    () => fixtureClientOptions((name) => fixtureEnvironment[name]),
    "missing required fixture environment variable: DOLT_HOST",
  );
});

Deno.test("DyfjMcpClient.connect fails before spawning when DOLT_PORT is invalid", async () => {
  const client = new DyfjMcpClient({
    serverExecutable: "/nonexistent/executable-that-must-not-be-spawned",
    childEnv: {
      DOLT_PORT: "3306,0.0.0.0",
    },
  });
  let thrown: Error | null = null;
  try {
    await client.connect();
  } catch (err: any) {
    thrown = err;
  }
  if (!thrown) {
    throw new Error("expected client.connect() to throw on invalid DOLT_PORT");
  }
  assertIncludes(
    thrown.message,
    "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
  );
  assertNotIncludes(thrown.message, "0.0.0.0");
  assertNotIncludes(thrown.message, "3306");
  assertNotIncludes(thrown.message, "nonexistent");
});

