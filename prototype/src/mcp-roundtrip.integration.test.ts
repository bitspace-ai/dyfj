import { DyfjMcpClient } from "./mcp-client.ts";

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
): ConstructorParameters<typeof DyfjMcpClient>[0] {
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

Deno.test(
  "production MCP client/server lists public memory and withholds private rows",
  async () => {
    const client = new DyfjMcpClient(fixtureClientOptions());
    try {
      await client.connect();
      const list = await client.listMemories();
      assertIncludes(list, "fixture_project_public");
      assertIncludes(list, "fixture_reference_client_safe");
      assertNotIncludes(list, "fixture_user_private");

      const publicMemory = await client.readMemory("fixture_project_public");
      assertIncludes(publicMemory, "public project content");
      await client.readMemory("fixture_user_private").then(
        () => {
          throw new Error("private fixture row was exposed through MCP");
        },
        (error: unknown) => assertIncludes(String(error), "Memory not found"),
      );
    } finally {
      await client.disconnect();
    }
  },
);

Deno.test("MCP round trip fails closed without fixture connection settings", () => {
  assertThrows(
    () => fixtureClientOptions(() => undefined),
    "missing required fixture environment variable: DENO_BIN",
  );
});
