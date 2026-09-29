import {
  assert,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { DomainError } from "../../contract/mod.ts";
import { RpcError, RpcErrorCode } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import { isTimeoutError, socketError } from "./errors.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("presentation", () => {
  // dispatchRequest (jsonrpc.ts) forwards a server error's message to
  // the client verbatim, and a rejected event-log INSERT can embed the whole
  // offending payload in that message (the original defect quoted pages of
  // source code this way). The client must never render that raw payload.
  it("socketError truncates an oversized message to a fixed label + byte-count, never the raw payload", () => {
    const payload = "SELECT ".repeat(20_000); // well over 100KB
    const s = socketError(new RangeError(payload), cfg());
    assert(s.length < 1000);
    assertFalse(s.includes(payload));
    // The label is the fixed literal "Error", not the subclass name — the
    // subclass name would come off the object (`.constructor.name`), a
    // writable property and therefore a payload channel.
    assertStringIncludes(s, "[Error,");
    assertFalse(s.includes("RangeError"));
    assertStringIncludes(
      s,
      `${new TextEncoder().encode(payload).byteLength} bytes`,
    );
  });

  it("socketError renders a short DomainError message unchanged — trusted by provenance", () => {
    const s = socketError(
      new DomainError("missing required argument: path"),
      cfg(),
    );
    assertStrictEquals(s, "dyfj: missing required argument: path");
  });

  it("socketError never passes a plain Error's message through, even a short one", () => {
    const message = "missing required argument: path";
    const s = socketError(new Error(message), cfg());
    assertFalse(s.includes(message));
    assertStrictEquals(
      s,
      `dyfj: [Error, ${new TextEncoder().encode(message).byteLength} bytes]`,
    );
  });

  it("socketError truncates a long Error payload without echoing it", () => {
    const payload = "x".repeat(200_000);
    const s = socketError(new Error(payload), cfg());
    assert(s.length < 1000);
    assertFalse(s.includes(payload));
    assertStringIncludes(s, "Error");
    assertStringIncludes(s, `${payload.length} bytes`);
  });
});

describe("isTimeoutError and socketError", () => {
  it("identifies TimeoutError instances and rejects non-timeout aborts", () => {
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";
    assertStrictEquals(isTimeoutError(timeoutErr), true);

    const abortWithTimeoutCause = new Error("The operation was aborted");
    abortWithTimeoutCause.name = "AbortError";
    abortWithTimeoutCause.cause = timeoutErr;
    assertStrictEquals(isTimeoutError(abortWithTimeoutCause), true);

    const plainAbortErr = new Error("The operation was aborted");
    plainAbortErr.name = "AbortError";
    assertStrictEquals(isTimeoutError(plainAbortErr), false);

    const messageTimeout = new Error("connection timed out");
    assertStrictEquals(isTimeoutError(messageTimeout), false);

    const regularErr = new Error("Something else failed");
    assertStrictEquals(isTimeoutError(regularErr), false);
  });

  it("socketError produces clear message on timeout", () => {
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";
    const msg = socketError(timeoutErr, cfg({ socket: "/tmp/dyfj.sock" }));
    assertStrictEquals(
      msg,
      "dyfj: runtime at /tmp/dyfj.sock is unresponsive (timed out)",
    );
  });

  it("socketError does not misclassify RpcError as unreachable socket", () => {
    const rpcErr = new RpcError(
      RpcErrorCode.methodNotFound,
      "Method not found",
    );
    const msg = socketError(rpcErr, cfg({ socket: "/tmp/dyfj.sock" }));
    assertStrictEquals(msg, "dyfj: Method not found");
    assertFalse(msg.includes("Start it with: dyfj start"));
  });

  it("socketError produces start hint on connection refused or missing socket", () => {
    const enoentErr = new Error("No such file or directory (os error 2)");
    const msgEnoent = socketError(enoentErr, cfg({ socket: "/tmp/dyfj.sock" }));
    assertStringIncludes(
      msgEnoent,
      "dyfj: runtime not reachable at /tmp/dyfj.sock.",
    );
    assertStringIncludes(msgEnoent, "Start it with: dyfj start");

    const econnrefusedErr = new Error("connect ECONNREFUSED /tmp/dyfj.sock");
    const msgRefused = socketError(
      econnrefusedErr,
      cfg({ socket: "/tmp/dyfj.sock" }),
    );
    assertStringIncludes(
      msgRefused,
      "dyfj: runtime not reachable at /tmp/dyfj.sock.",
    );
    assertStringIncludes(msgRefused, "Start it with: dyfj start");
  });
});
