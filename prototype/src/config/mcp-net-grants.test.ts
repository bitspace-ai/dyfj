import {
  assertFalse,
  assertStrictEquals,
  assertThrows,
  fail,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { buildDoltAllowNetGrant, validateDoltPort } from "./mcp-net-grants.ts";

describe("validateDoltPort & buildDoltAllowNetGrant", () => {
  it("accepts valid boundary and ordinary port numbers and strings", () => {
    assertStrictEquals(validateDoltPort(), 3306);
    assertStrictEquals(validateDoltPort(undefined), 3306);
    assertStrictEquals(validateDoltPort(null), 3306);
    assertStrictEquals(validateDoltPort("3306"), 3306);
    assertStrictEquals(validateDoltPort("3316"), 3316);
    assertStrictEquals(validateDoltPort("1"), 1);
    assertStrictEquals(validateDoltPort("65535"), 65535);
    assertStrictEquals(validateDoltPort(3306), 3306);
    assertStrictEquals(validateDoltPort(1), 1);
    assertStrictEquals(validateDoltPort(65535), 65535);

    assertStrictEquals(buildDoltAllowNetGrant(), "--allow-net=127.0.0.1:3306");
    assertStrictEquals(
      buildDoltAllowNetGrant("3306"),
      "--allow-net=127.0.0.1:3306",
    );
    assertStrictEquals(buildDoltAllowNetGrant("1"), "--allow-net=127.0.0.1:1");
    assertStrictEquals(
      buildDoltAllowNetGrant("65535"),
      "--allow-net=127.0.0.1:65535",
    );
    assertStrictEquals(
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
      assertThrows(
        () => validateDoltPort(input),
        Error,
        "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
        `expected validateDoltPort(${JSON.stringify(input)}) to throw`,
      );

      assertThrows(
        () => buildDoltAllowNetGrant(input),
        Error,
        "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
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
        fail("should have thrown");
      } catch (err: any) {
        assertStrictEquals(
          err.message,
          "invalid DOLT_PORT: must be a decimal integer between 1 and 65535",
        );
        assertFalse(err.message.includes("SECRET_KEY_VALUE"));
        assertFalse(err.message.includes("/private/keys"));
        assertFalse(err.message.includes("op://"));
        assertFalse(err.message.includes("password123"));
      }
    }
  });
});
