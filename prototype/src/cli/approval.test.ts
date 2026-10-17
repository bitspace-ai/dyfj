import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeIo } from "../../testing/fakes/fake-io.ts";
import { promptMidTurnApproval } from "./approval.ts";
import type { Io } from "./io.ts";

describe("promptMidTurnApproval", () => {
  const acpPermissionRequest = {
    kind: "external_agent_permission",
    title: "Run shell command?",
    arguments: { "ACP tool": "terminal" },
    options: [
      {
        optionId: "allow-once-id",
        name: "Allow Once",
        kind: "allow_once",
      },
      {
        optionId: "allow-session-id",
        name: "Allow for Session",
        kind: "allow_always",
      },
      {
        optionId: "reject-id",
        name: "Reject",
        kind: "reject_once",
      },
    ],
  };
  const emptyAllowOnlyRequest = {
    kind: "external_agent_permission",
    title: "Run shell command?",
    options: [{
      optionId: "",
      name: "Allow Once",
      kind: "allow_once",
    }],
  };

  for (
    const [answer, optionId] of [
      ["1", "allow-once-id"],
      ["2", "allow-session-id"],
      ["3", "reject-id"],
    ]
  ) {
    it(`returns the exact ACP option id selected by number (${answer})`, async () => {
      const { io } = fakeIo([answer]);
      assert.deepStrictEqual(
        await promptMidTurnApproval(io, acpPermissionRequest, true),
        { decision: "select", optionId },
      );
    });
  }

  it("renders every ACP label once, including a dynamic remembered-command option", async () => {
    const dynamic = {
      ...acpPermissionRequest,
      options: [
        ...acpPermissionRequest.options,
        {
          optionId: "remember-command-id",
          name: "Always allow `git status`",
          kind: "allow_always",
        },
      ],
    };
    const { io, stderr } = fakeIo(["4"]);
    assert.deepStrictEqual(await promptMidTurnApproval(io, dynamic, true), {
      decision: "select",
      optionId: "remember-command-id",
    });
    const rendered = stderr.join("\n");
    for (const option of dynamic.options) {
      assert.deepStrictEqual(
        rendered.match(
          new RegExp(option.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        )?.length,
        1,
      );
    }
  });

  it("an explicit empty ACP input selects the advertised default rejection", async () => {
    const { io } = fakeIo([""]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, true),
      {
        decision: "select",
        optionId: "reject-id",
      },
    );
  });

  it("closed ACP input defaults to policy rejection", async () => {
    const { io } = fakeIo([]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, true),
      {
        decision: "deny",
        reason: "ACP permission selection unavailable",
      },
    );
  });

  it("invalid ACP input corrects and re-prompts without duplicating the request", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "2"]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, true),
      {
        decision: "select",
        optionId: "allow-session-id",
      },
    );
    assert.deepStrictEqual(prompts.length, 2);
    assert.deepStrictEqual(
      (stderr.filter((line) => line.includes("Run shell command?"))).length,
      1,
    );
    assert.deepStrictEqual(
      (stderr.filter((line) => line.includes("Allow Once"))).length,
      1,
    );
    assert.ok(
      stderr.join("\n").includes("Enter a number from 1 to 3."),
      `expected stderr.join("\\n") to include "Enter a number from 1 to 3."`,
    );
  });

  it("an oversized ACP selection is rejected before parsing", async () => {
    const { io, prompts } = fakeIo([` 2${" ".repeat(63)}`, "1"]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, true),
      {
        decision: "select",
        optionId: "allow-once-id",
      },
    );
    assert.deepStrictEqual(prompts.length, 2);
  });

  it("three invalid ACP selections exhaust the bounded prompt and reject", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "0", "4", "1"]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, true),
      {
        decision: "deny",
        reason: "ACP permission selection unavailable",
      },
    );
    assert.deepStrictEqual(prompts.length, 3);
    assert.deepStrictEqual(
      (stderr.filter((line) => line === "   Enter a number from 1 to 3."))
        .length,
      3,
    );
  });

  for (
    const [label, interactive, lines] of [
      ["non-interactive", false, ["1"]],
      ["closed input", true, []],
    ] as [string, boolean, string[]][]
  ) {
    it(`an empty allow id with no rejection fails closed on ${label}`, async () => {
      const { io, stderr } = fakeIo(lines);
      assert.deepStrictEqual(
        await promptMidTurnApproval(io, emptyAllowOnlyRequest, interactive),
        {
          decision: "deny",
          reason: "ACP rejection option unavailable",
        },
      );
      if (interactive) {
        assert.deepStrictEqual(
          (stderr.filter((line) =>
            line === "   ACP permission options were invalid; request rejected."
          )).length,
          1,
        );
      }
    });
  }

  it("an all-or-nothing ACP option parse failure reports one fixed diagnostic", async () => {
    const { io, stderr, prompts } = fakeIo(["1"]);
    const duplicate = {
      ...acpPermissionRequest,
      options: acpPermissionRequest.options.map((option) => ({
        ...option,
        optionId: "duplicate",
      })),
    };
    assert.deepStrictEqual(await promptMidTurnApproval(io, duplicate, true), {
      decision: "deny",
      reason: "ACP rejection option unavailable",
    });
    assert.deepStrictEqual(prompts.length, 0);
    assert.deepStrictEqual(
      (stderr.filter((line) =>
        line === "   ACP permission options were invalid; request rejected."
      )).length,
      1,
    );
  });

  it("cancellation aborts a pending ACP selection without choosing an option", async () => {
    const controller = new AbortController();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
          controller.abort();
        }),
      close: () => {},
    };
    assert.deepStrictEqual(
      await promptMidTurnApproval(
        io,
        acpPermissionRequest,
        true,
        controller.signal,
      ),
      { decision: "abort" },
    );
  });

  it("a non-interactive ACP request defaults to policy rejection without prompting", async () => {
    const { io, prompts } = fakeIo(["1"]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, acpPermissionRequest, false),
      {
        decision: "deny",
        reason: "ACP permission selection unavailable",
      },
    );
    assert.deepStrictEqual(prompts.length, 0);
  });

  it("approves on y", async () => {
    const { io } = fakeIo(["y"]);
    assert.deepStrictEqual(
      await promptMidTurnApproval(io, {
        title: "Write File",
        arguments: { path: "a" },
      }, true),
      { decision: "approve" },
    );
  });
  it("shows the timeout the runtime put in a bash request's title", async () => {
    const { io, stderr } = fakeIo(["y"]);
    await promptMidTurnApproval(io, {
      commandId: "bash",
      callId: "call-1",
      title: "Run Bash Command (timeout 300 s)",
      arguments: { command: "npm test", timeoutSec: 300 },
    }, true);
    const rendered = stderr.join("\n");
    assert.ok(
      rendered.includes("approve Run Bash Command (timeout 300 s)?"),
      `expected ${
        JSON.stringify(rendered)
      } to include "approve Run Bash Command (timeout 300 s)?"`,
    );
    assert.ok(
      rendered.includes("timeoutSec: 300"),
      `expected ${JSON.stringify(rendered)} to include "timeoutSec: 300"`,
    );
  });

  it("denies on anything else", async () => {
    const { io } = fakeIo(["n"]);
    assert.strictEqual(
      (await promptMidTurnApproval(io, {}, true)).decision,
      "deny",
    );
  });
  it("reports an interrupted approval separately from a denial", async () => {
    const abortController = new AbortController();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) => {
        abortController.abort();
        assert.strictEqual(signal?.aborted, true);
        return Promise.resolve(null);
      },
      close: () => {},
    };
    assert.deepStrictEqual(
      await promptMidTurnApproval(
        io,
        {},
        true,
        abortController.signal,
      ),
      { decision: "abort" },
    );
  });
  it("denies without prompting when non-interactive", async () => {
    let asked = false;
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: () => {
        asked = true;
        return Promise.resolve("y");
      },
      close: () => {},
    };
    const verdict = await promptMidTurnApproval(io, {}, false);
    assert.strictEqual(verdict.decision, "deny");
    assert.strictEqual(asked, false);
  });

  it("runaway_anomaly gets its own hard-stop prompt and approves on y", async () => {
    const { io, stderr } = fakeIo(["y"]);
    const verdict = await promptMidTurnApproval(io, {
      kind: "runaway_anomaly",
      message: "Runaway spend anomaly — hard stop",
    }, true);
    assert.deepStrictEqual(verdict, { decision: "approve" });
    assert.ok(
      stderr.join("\n").includes("Runaway spend anomaly — hard stop"),
      `expected stderr.join("\\n") to include "Runaway spend anomaly — hard stop"`,
    );
    assert.ok(!(stderr.join("\n")).includes("exceed budget ceiling"));
  });

  it("runaway_anomaly denies on anything but yes", async () => {
    const { io } = fakeIo([""]);
    const verdict = await promptMidTurnApproval(io, {
      kind: "runaway_anomaly",
    }, true);
    assert.strictEqual(verdict.decision, "deny");
  });
});
