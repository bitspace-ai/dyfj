import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SECRET_TIMEOUT_MS,
  loadSecretsConfig,
  parseSecretsConfig,
} from "./secrets-config.ts";

// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_PRIVATE_HOME = ["", "Users", "private-account"].join("/");

{ // "parseSecretsConfig"
  const PATH = "/h/.dyfj/config.toml";

  test("parseSecretsConfig: null table or absent [secrets] → null (no resolution)", () => {
    assert.strictEqual(parseSecretsConfig(null, PATH), null);
    assert.strictEqual(parseSecretsConfig({ companion: {} }, PATH), null);
  });

  test("parseSecretsConfig: parses command, timeout, and declared pointers", () => {
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
    assert.deepStrictEqual(cfg, {
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

  test("parseSecretsConfig: defaults timeout, env, and inherit_env when omitted", () => {
    const cfg = parseSecretsConfig(
      { secrets: { command: ["op", "read"] } },
      PATH,
    );
    assert.strictEqual(cfg?.timeoutMs, DEFAULT_SECRET_TIMEOUT_MS);
    assert.deepStrictEqual(cfg?.pointers, {});
    assert.deepStrictEqual(cfg?.env, {});
    assert.deepStrictEqual(cfg?.inheritEnv, []);
  });

  test("parseSecretsConfig: parses [secrets].inherit_env as a forward-list of ambient var names", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          inherit_env: ["OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"],
        },
      },
      PATH,
    );
    assert.deepStrictEqual(cfg?.inheritEnv, [
      "OP_SERVICE_ACCOUNT_TOKEN",
      "OP_ACCOUNT",
    ]);
  });

  test("parseSecretsConfig: inherit_env rejects denylisted and declared-secret names", () => {
    for (const name of ["PATH", "HOME", "LD_PRELOAD"]) {
      assert.match(
        (captureThrow(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], inherit_env: [name] } },
            PATH,
          )
        ) as Error).message,
        /inherit_env may not name/,
      );
    }
    assert.match(
      (captureThrow(() =>
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

  test("parseSecretsConfig: inherit_env rejects a wildcard / metacharacter name (--allow-env=* bypass)", () => {
    for (const name of ["*", "A=B", "FOO BAR", "1BAD", "A*"]) {
      assert.match(
        (captureThrow(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], inherit_env: [name] } },
            PATH,
          )
        ) as Error).message,
        /not a valid environment variable name/,
      );
    }
  });

  test("parseSecretsConfig: [secrets.env] rejects an invalid environment variable name", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { "*": "x" } } },
          PATH,
        )
      ) as Error).message,
      /not a valid environment variable name/,
    );
  });

  test("parseSecretsConfig: inherit_env must be an array of non-empty strings", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: "OP_TOKEN" } },
          PATH,
        )
      ) as Error).message,
      /must be an array/,
    );
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: [""] } },
          PATH,
        )
      ) as Error).message,
      /non-empty strings/,
    );
  });

  test("parseSecretsConfig: parses [secrets.env] as a non-secret string map", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          env: { OP_ACCOUNT: "my.1password.com", RESOLVER_FLAG: "1" },
        },
      },
      PATH,
    );
    assert.deepStrictEqual(cfg?.env, {
      OP_ACCOUNT: "my.1password.com",
      RESOLVER_FLAG: "1",
    });
  });

  test("parseSecretsConfig: a non-string [secrets.env] value fails loud", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { OP_DEBUG: true } } },
          PATH,
        )
      ) as Error).message,
      /\[secrets\.env\]\.OP_DEBUG must be a string/,
    );
  });

  test("parseSecretsConfig: a security-relevant [secrets.env] name (PATH/HOME/linker) is rejected", () => {
    for (
      const name of ["PATH", "HOME", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]
    ) {
      assert.match(
        (captureThrow(() =>
          parseSecretsConfig(
            { secrets: { command: ["op", "read"], env: { [name]: "/evil" } } },
            PATH,
          )
        ) as Error).message,
        /is not allowed/,
      );
    }
  });

  test("parseSecretsConfig: a declared secret env var as a plaintext [secrets.env] value is rejected", () => {
    // The engine can enforce the no-plaintext-credential boundary for names it
    // knows are secret — a declared secret-pointer key must use a pointer.
    for (const name of ["ANTHROPIC_API_KEY", "DYFJ_MEMORY_MCP_TOKEN"]) {
      assert.match(
        (captureThrow(() =>
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

  test("parseSecretsConfig: a missing command fails loud", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, PATH)
      ) as Error).message,
      /command is required/,
    );
  });

  test("parseSecretsConfig: validation errors are path-free (no absolute config path on boot stderr)", () => {
    const privatePath = `${FAKE_PRIVATE_HOME}/.dyfj/config.toml`;
    try {
      parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, privatePath);
      throw new Error("expected a validation throw");
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /command is required/);
      assert.ok(!msg.includes("private-account"));
      assert.ok(!msg.includes(privatePath));
      // The stable public-safe label is fine.
      assert.ok(msg.includes("config.toml"));
    }
  });

  test("parseSecretsConfig: an empty or non-string command fails loud", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig({ secrets: { command: [] } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig({ secrets: { command: [""] } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig({ secrets: { command: "op read" } }, PATH)
      ) as Error).message,
      /non-empty array/,
    );
  });

  test("parseSecretsConfig: a non-positive timeout fails loud", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op"], timeout_ms: 0 } },
          PATH,
        )
      ) as Error).message,
      /positive number/,
    );
  });

  test("parseSecretsConfig: a pointer for an undeclared or non-secret key fails loud", () => {
    assert.match(
      (captureThrow(() =>
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
    assert.match(
      (captureThrow(() =>
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

  test("parseSecretsConfig: an empty pointer value fails loud", () => {
    assert.match(
      (captureThrow(() =>
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
  test("loadSecretsConfig: shares the file read; a missing file yields null", async () => {
    const cfg = await loadSecretsConfig({
      env: { get: (k) => (k === "HOME" ? "/h" : undefined) },
      readTextFile: () =>
        Promise.reject(
          Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
        ),
    });
    assert.strictEqual(cfg, null);
  });

  test("loadSecretsConfig: parses the [secrets] section from the config file", async () => {
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
    assert.deepStrictEqual(cfg?.command, ["op", "read"]);
    assert.strictEqual(
      cfg?.pointers.OPENAI_API_KEY,
      "op://v/openai/credential",
    );
    assert.strictEqual(cfg?.named?.linear_mcp, "op://v/linear/credential");
  });

  test("loadSecretsConfig: rejects more than 64 named credentials before resolver fan-out", () => {
    const named = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `credential_${index}`,
        `op://v/item-${index}/credential`,
      ]),
    );
    assert.match(
      (captureThrow(() =>
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
  test("parseSecretsConfig — strict [secrets] keys: an unknown [secrets] key (typo) fails loud", () => {
    assert.match(
      (captureThrow(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], timeouts_ms: 5000 } },
          PATH,
        )
      ) as Error).message,
      /not a recognized key/,
    );
  });
}
