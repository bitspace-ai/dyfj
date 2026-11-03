/**
 * A socket the runtime cannot bind, or a client cannot reach, says why.
 *
 * A path longer than the platform's `sun_path` made the runtime die with an
 * uncaught `listen EINVAL` stack trace, and the client report the connect as
 * `[Error, N bytes]`. The node:net adapter now checks the length itself and
 * maps a bind failure's code to a message naming the path and the fix.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError, summarizeError } from "../contract/mod.ts";
import { nodeSocketHost } from "./node-socket.ts";
import {
  maxSocketPathBytes,
  RuntimeListenError,
  SocketPathTooLongError,
} from "./socket-failure.ts";

/** A path of exactly `bytes` bytes under a short existing directory. */
function pathOfBytes(dir: string, bytes: number): string {
  const prefix = `${dir}/`;
  return prefix + "s".repeat(bytes - prefix.length);
}

test("the platform's limit is the sun_path size less its terminating NUL", () => {
  assert.equal(maxSocketPathBytes("darwin"), 103);
  assert.equal(maxSocketPathBytes("linux"), 107);
});

test("listen on a too-long path names its length, the limit and the fix", async () => {
  const dir = mkdtempSync(join("/tmp", "dyfj_sf_"));
  try {
    const path = pathOfBytes(dir, maxSocketPathBytes() + 1);
    await assert.rejects(
      () => nodeSocketHost.listen(path),
      (error: unknown) => {
        assert.ok(error instanceof SocketPathTooLongError, String(error));
        assert.ok(error instanceof DomainError);
        assert.match(
          error.message,
          new RegExp(`is ${maxSocketPathBytes() + 1} bytes`),
        );
        assert.match(error.message, new RegExp(`${maxSocketPathBytes()}`));
        assert.match(error.message, /DYFJ_SOCKET/);
        assert.match(error.message, /--socket/);
        assert.ok(error.message.includes(path));
        assert.equal(summarizeError(error), error.message);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path at the limit still binds", async () => {
  const dir = mkdtempSync(join("/tmp", "dyfj_sf_"));
  try {
    const listener = await nodeSocketHost.listen(
      pathOfBytes(dir, maxSocketPathBytes()),
    );
    await listener.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connect to a too-long path reports the same error", async () => {
  const path = pathOfBytes("/tmp", maxSocketPathBytes() + 20);
  await assert.rejects(
    () => nodeSocketHost.connect(path),
    SocketPathTooLongError,
  );
});

test("listen in a directory that does not exist names the directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dyfj_sf_"));
  try {
    const path = `${dir}/missing/wb.sock`;
    await assert.rejects(
      () => nodeSocketHost.listen(path),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeListenError, String(error));
        assert.ok(error instanceof DomainError);
        assert.match(error.message, /could not listen on/);
        assert.ok(error.message.includes(path));
        assert.match(error.message, /directory does not exist/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
