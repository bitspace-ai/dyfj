import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDoltAllowNetGrant, validateDoltPort } from "./mcp-net-grants.ts";

describe("validateDoltPort & buildDoltAllowNetGrant", () => {
  it("accepts valid boundary and ordinary port numbers and strings", () => {
    assert.strictEqual(validateDoltPort(), 3306);
    assert.strictEqual(validateDoltPort(undefined), 3306);
    assert.strictEqual(validateDoltPort(null), 3306);
    assert.strictEqual(validateDoltPort("3306"), 3306);
    assert.strictEqual(validateDoltPort("3316"), 3316);
    assert.strictEqual(validateDoltPort("1"), 1);
    assert.strictEqual(validateDoltPort("65535"), 65535);
    assert.strictEqual(validateDoltPort(3306), 3306);
    assert.strictEqual(validateDoltPort(1), 1);
    assert.strictEqual(validateDoltPort(65535), 65535);

    assert.strictEqual(buildDoltAllowNetGrant(), "--allow-net=127.0.0.1:3306");
    assert.strictEqual(
      buildDoltAllowNetGrant("3306"),
      "--allow-net=127.0.0.1:3306",
    );
    assert.strictEqual(buildDoltAllowNetGrant("1"), "--allow-net=127.0.0.1:1");
    assert.strictEqual(
      buildDoltAllowNetGrant("65535"),
      "--allow-net=127.0.0.1:65535",
    );
    assert.strictEqual(
      buildDoltAllowNetGrant(3316),
      "--allow-net=127.0.0.1:3316",
    );
  });

  it("rejects malformed, delimiter-bearing, signed, whitespace, and out-of-range ports", () => {
    const invalidInputs = [
      // Delimiters / network injection attempts
      "3306,0.0.0.0",
      "3306,localhost",
      "3306,127.0.0.1:8080",
      "127.0.0.1:3306",
      "3306;80",
      "3306/tcp",
      "3306 80",
      // Whitespace
      " 3306",
      "3306 ",
      "\t3306",
      "33 06",
      // Signs
      "+3306",
      "-3306",
      "+1",
      "-1",
      // Out of range & oversized
      "0",
      "65536",
      "100000",
      "123456",
      "9".repeat(10_000),
      0,
      65536,
      -1,
      // Non-decimal / formatting
      "",
      "   ",
      "abc",
      "3306a",
      "0x3306",
      "33e2",
      "3306.0",
      "3306.5",
      "NaN",
      "Infinity",
      // Non-port types
      true,
      false,
      {},
      [],
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => validateDoltPort(input),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
          ),
        `expected validateDoltPort(${JSON.stringify(input)}) to throw`,
      );

      assert.throws(
        () => buildDoltAllowNetGrant(input),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
          ),
        `expected buildDoltAllowNetGrant(${JSON.stringify(input)}) to throw`,
      );
    }
  });

  it("rejection diagnostic is path-free and credential-free", () => {
    const sensitiveInputs = [
      "3306,SECRET_KEY_VALUE",
      "/private/keys/dolt:3306",
      "op://vault/dolt/port",
      "password123,0.0.0.0",
    ];

    for (const input of sensitiveInputs) {
      try {
        buildDoltAllowNetGrant(input);
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.strictEqual(
          err.message,
          "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
        );
        assert.ok(!err.message.includes("SECRET_KEY_VALUE"));
        assert.ok(!err.message.includes("/private/keys"));
        assert.ok(!err.message.includes("op://"));
        assert.ok(!err.message.includes("password123"));
      }
    }
  });
});
