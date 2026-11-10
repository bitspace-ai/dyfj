// The posture line lists the session's roots when it has added ones.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPostureLine, formatRoots } from "./posture.ts";

describe("formatRoots", () => {
  it("lists the workspace and each added root, marking read-only ones", () => {
    assert.strictEqual(
      formatRoots("/op-home/projects/main-repo", [
        { path: "/op-home/wt", readOnly: false },
        { path: "/op-home/ref", readOnly: true },
      ]),
      "roots: /op-home/projects/main-repo, /op-home/wt, /op-home/ref (read-only)",
    );
  });

  it("names a resumed session's stored workspace without a path", () => {
    assert.strictEqual(
      formatRoots(undefined, [{ path: "/wt", readOnly: false }]),
      "roots: (session workspace), /wt",
    );
  });

  it("adds nothing without added roots", () => {
    assert.strictEqual(formatRoots("/ws", undefined), null);
    assert.strictEqual(formatRoots("/ws", []), null);
    assert.doesNotMatch(
      formatPostureLine({ slug: "m", approvePaidSession: false, workspace: "/ws" }),
      /roots:/,
    );
  });

  it("ends the posture line with the roots", () => {
    assert.match(
      formatPostureLine({
        slug: "m",
        approvePaidSession: false,
        workspace: "/ws",
        additionalRoots: [{ path: "/wt", readOnly: true }],
      }),
      / · roots: \/ws, \/wt \(read-only\)$/,
    );
  });
});
