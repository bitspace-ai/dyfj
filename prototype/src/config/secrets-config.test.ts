import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);
import {
  DEFAULT_SECRET_TIMEOUT_MS,
  loadSecretsConfig,
  parseSecretsConfig,
} from "./secrets-config.ts";

const HOME = { HOME: "/h" };
// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_PRIVATE_HOME = ["", "Users", "private-account"].join("/");
const notFound = () => Promise.reject(new Deno.errors.NotFound());
const present = () =>
  Promise.resolve("(toml text — parsed by the injected parser)");
const table = (t: Record<string, unknown>) => () => t;

{ // "parseSecretsConfig"
  const PATH = "/h/.dyfj/config.toml";

  Deno.test("parseSecretsConfig: null table or absent [secrets] → null (no resolution)", () => {
    assertStrictEquals(parseSecretsConfig(null, PATH), null);
    assertStrictEquals(parseSecretsConfig({ companion: {} }, PATH), null);
  });

  Deno.test("parseSecretsConfig: parses command, timeout, and declared pointers", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          timeout_ms: 5000,
          pointers: {
            ANTHROPIC_API_KEY: "op://v/anthropic/credential",
            DYFJ_MEMORY_MCP_TOKEN: "op://v/brain/credential",
          },
        },
      },
      PATH,
    );
    assertEquals(cfg, {
      command: ["op", "read"],
      timeoutMs: 5000,
      pointers: {
        ANTHROPIC_API_KEY: "op://v/anthropic/credential",
        DYFJ_MEMORY_MCP_TOKEN: "op://v/brain/credential",
      },
      named: {},
      env: {},
      inheritEnv: [],
    });
  });

  Deno.test("parseSecretsConfig: defaults timeout, env, and inherit_env when omitted", () => {
    const cfg = parseSecretsConfig(
      { secrets: { command: ["op", "read"] } },
      PATH,
    );
    assertStrictEquals(cfg?.timeoutMs, DEFAULT_SECRET_TIMEOUT_MS);
    assertEquals(cfg?.pointers, {});
    assertEquals(cfg?.env, {});
    assertEquals(cfg?.inheritEnv, []);
  });

  Deno.test("parseSecretsConfig: parses [secrets].inherit_env as a forward-list of ambient var names", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          inherit_env: ["OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"],
        },
      },
      PATH,
    );
    assertEquals(cfg?.inheritEnv, ["OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"]);
  });

  Deno.test("parseSecretsConfig: inherit_env rejects denylisted and declared-secret names", () => {
    for (const name of ["PATH", "HOME", "LD_PRELOAD"]) {
      assertMatch(
        (assertThrows(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], inherit_env: [name] } },
            PATH,
          )
        ) as Error).message,
        /inherit_env may not name/,
      );
    }
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          {
            secrets: {
              command: ["op", "read"],
              inherit_env: ["ANTHROPIC_API_KEY"],
            },
          },
          PATH,
        )
      ) as Error).message,
      /inherit_env may not name the declared secret/,
    );
  });

  Deno.test("parseSecretsConfig: inherit_env rejects a wildcard / metacharacter name (--allow-env=* bypass)", () => {
    for (const name of ["*", "A=B", "FOO BAR", "1BAD", "A*"]) {
      assertMatch(
        (assertThrows(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], inherit_env: [name] } },
            PATH,
          )
        ) as Error).message,
        /not a valid environment variable name/,
      );
    }
  });

  Deno.test("parseSecretsConfig: [secrets.env] rejects an invalid environment variable name", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { "*": "x" } } },
          PATH,
        )
      ) as Error).message,
      /not a valid environment variable name/,
    );
  });

  Deno.test("parseSecretsConfig: inherit_env must be an array of non-empty strings", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: "OP_TOKEN" } },
          PATH,
        )
      ) as Error).message,
      /must be an array/,
    );
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: [""] } },
          PATH,
        )
      ) as Error).message,
      /non-empty strings/,
    );
  });

  Deno.test("parseSecretsConfig: parses [secrets.env] as a non-secret string map", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          env: { OP_ACCOUNT: "my.1password.com", RESOLVER_FLAG: "1" },
        },
      },
      PATH,
    );
    assertEquals(cfg?.env, {
      OP_ACCOUNT: "my.1password.com",
      RESOLVER_FLAG: "1",
    });
  });

  Deno.test("parseSecretsConfig: a non-string [secrets.env] value fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { OP_DEBUG: true } } },
          PATH,
        )
      ) as Error).message,
      /\[secrets\.env\]\.OP_DEBUG must be a string/,
    );
  });

  Deno.test("parseSecretsConfig: a security-relevant [secrets.env] name (PATH/HOME/linker) is rejected", () => {
    for (
      const name of ["PATH", "HOME", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]
    ) {
      assertMatch(
        (assertThrows(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], env: { [name]: "/evil" } } },
            PATH,
          )
        ) as Error).message,
        /is not allowed/,
      );
    }
  });

  Deno.test("parseSecretsConfig: a declared secret env var as a plaintext [secrets.env] value is rejected", () => {
    // The engine can enforce the no-plaintext-credential boundary for names it
    // knows are secret — a declared secret-pointer key must use a pointer.
    for (const name of ["ANTHROPIC_API_KEY", "DYFJ_MEMORY_MCP_TOKEN"]) {
      assertMatch(
        (assertThrows(() =>
          parseSecretsConfig(
            {
              secrets: { command: ["op", "read"], env: { [name]: "sk-plain" } },
            },
            PATH,
          )
        ) as Error).message,
        /is a declared secret/,
      );
    }
  });

  Deno.test("parseSecretsConfig: a missing command fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, PATH)
      ) as Error).message,
      /command is required/,
    );
  });

  Deno.test("parseSecretsConfig: validation errors are path-free (no absolute config path on boot stderr)", () => {
    const privatePath = `${FAKE_PRIVATE_HOME}/.dyfj/config.toml`;
    try {
      parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, privatePath);
      throw new Error("expected a validation throw");
    } catch (err) {
      const msg = (err as Error).message;
      assertMatch(msg, /command is required/);
      assertFalse(msg.includes("private-account"));
      assertFalse(msg.includes(privatePath));
      // The stable public-safe label is fine.
      assert(msg.includes("config.toml"));
    }
  });

  Deno.test("parseSecretsConfig: an empty or non-string command fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig({ secrets: { command: [] } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig({ secrets: { command: [""] } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig({ secrets: { command: "op read" } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
  });

  Deno.test("parseSecretsConfig: a non-positive timeout fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op"], timeout_ms: 0 } },
          PATH,
        )
      ) as Error).message,
      /positive number/,
    );
  });

  Deno.test("parseSecretsConfig: a pointer for an undeclared or non-secret key fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          {
            secrets: {
              command: ["op", "read"],
              pointers: { NOT_A_SECRET: "op://x" },
            },
          },
          PATH,
        )
      ) as Error).message,
      /not a declared secret env var/,
    );
    // A declared VALUE key (not a secret pointer) is rejected too.
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          {
            secrets: {
              command: ["op", "read"],
              pointers: { DYFJ_MEMORY_MCP_URL: "op://x" },
            },
          },
          PATH,
        )
      ) as Error).message,
      /not a declared secret env var/,
    );
  });

  Deno.test("parseSecretsConfig: an empty pointer value fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          {
            secrets: {
              command: ["op", "read"],
              pointers: { ANTHROPIC_API_KEY: "" },
            },
          },
          PATH,
        )
      ) as Error).message,
      /non-empty string/,
    );
  });
}

{ // "loadSecretsConfig"
  Deno.test("loadSecretsConfig: shares the file read; a missing file yields null", async () => {
    const cfg = await loadSecretsConfig({
      env: { get: (k) => (k === "HOME" ? "/h" : undefined) },
      readTextFile: () => Promise.reject(new Deno.errors.NotFound()),
    });
    assertStrictEquals(cfg, null);
  });

  Deno.test("loadSecretsConfig: parses the [secrets] section from the config file", async () => {
    const cfg = await loadSecretsConfig({
      env: { get: (k) => (k === "HOME" ? "/h" : undefined) },
      readTextFile: () => Promise.resolve("(toml)"),
      parseToml: () => ({
        secrets: {
          command: ["op", "read"],
          pointers: { OPENAI_API_KEY: "op://v/openai/credential" },
          named: { linear_mcp: "op://v/linear/credential" },
        },
      }),
    });
    assertEquals(cfg?.command, ["op", "read"]);
    assertStrictEquals(
      cfg?.pointers.OPENAI_API_KEY,
      "op://v/openai/credential",
    );
    assertStrictEquals(cfg?.named?.linear_mcp, "op://v/linear/credential");
  });

  Deno.test("loadSecretsConfig: rejects more than 64 named credentials before resolver fan-out", () => {
    const named = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `credential_${index}`,
        `op://v/item-${index}/credential`,
      ]),
    );
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], named } },
          "/h/.dyfj/config.toml",
        )
      ) as Error).message,
      /secrets\.named.*64/,
    );
  });
}

{ // "parseSecretsConfig — strict [secrets] keys"
  const PATH = "/h/.dyfj/config.toml";
  Deno.test("parseSecretsConfig — strict [secrets] keys: an unknown [secrets] key (typo) fails loud", () => {
    assertMatch(
      (assertThrows(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], timeouts_ms: 5000 } },
          PATH,
        )
      ) as Error).message,
      /not a recognized key/,
    );
  });
}
