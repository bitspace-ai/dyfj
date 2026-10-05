import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
      assertEquals(
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
    assertEquals(await promptMidTurnApproval(io, dynamic, true), {
      decision: "select",
      optionId: "remember-command-id",
    });
    const rendered = stderr.join("\n");
    for (const option of dynamic.options) {
      assertEquals(
        rendered.match(
          new RegExp(option.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        )?.length,
        1,
      );
    }
  });

  it("an explicit empty ACP input selects the advertised default rejection", async () => {
    const { io } = fakeIo([""]);
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, true), {
      decision: "select",
      optionId: "reject-id",
    });
  });

  it("closed ACP input defaults to policy rejection", async () => {
    const { io } = fakeIo([]);
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, true), {
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
  });

  it("invalid ACP input corrects and re-prompts without duplicating the request", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "2"]);
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, true), {
      decision: "select",
      optionId: "allow-session-id",
    });
    assertEquals(prompts.length, 2);
    assertEquals(
      (stderr.filter((line) => line.includes("Run shell command?"))).length,
      1,
    );
    assertEquals(
      (stderr.filter((line) => line.includes("Allow Once"))).length,
      1,
    );
    assertStringIncludes(stderr.join("\n"), "Enter a number from 1 to 3.");
  });

  it("an oversized ACP selection is rejected before parsing", async () => {
    const { io, prompts } = fakeIo([` 2${" ".repeat(63)}`, "1"]);
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, true), {
      decision: "select",
      optionId: "allow-once-id",
    });
    assertEquals(prompts.length, 2);
  });

  it("three invalid ACP selections exhaust the bounded prompt and reject", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "0", "4", "1"]);
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, true), {
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
    assertEquals(prompts.length, 3);
    assertEquals(
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
      assertEquals(
        await promptMidTurnApproval(io, emptyAllowOnlyRequest, interactive),
        {
          decision: "deny",
          reason: "ACP rejection option unavailable",
        },
      );
      if (interactive) {
        assertEquals(
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
    assertEquals(await promptMidTurnApproval(io, duplicate, true), {
      decision: "deny",
      reason: "ACP rejection option unavailable",
    });
    assertEquals(prompts.length, 0);
    assertEquals(
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
    assertEquals(
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
    assertEquals(await promptMidTurnApproval(io, acpPermissionRequest, false), {
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
    assertEquals(prompts.length, 0);
  });

  it("approves on y", async () => {
    const { io } = fakeIo(["y"]);
    assertEquals(
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
      arguments: { command: "deno task test", timeoutSec: 300 },
    }, true);
    const rendered = stderr.join("\n");
    assertStringIncludes(rendered, "approve Run Bash Command (timeout 300 s)?");
    assertStringIncludes(rendered, "timeoutSec: 300");
  });

  it("denies on anything else", async () => {
    const { io } = fakeIo(["n"]);
    assertStrictEquals(
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
        assertStrictEquals(signal?.aborted, true);
        return Promise.resolve(null);
      },
      close: () => {},
    };
    assertEquals(
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
    assertStrictEquals(verdict.decision, "deny");
    assertStrictEquals(asked, false);
  });

  it("runaway_anomaly gets its own hard-stop prompt and approves on y", async () => {
    const { io, stderr } = fakeIo(["y"]);
    const verdict = await promptMidTurnApproval(io, {
      kind: "runaway_anomaly",
      message: "Runaway spend anomaly — hard stop",
    }, true);
    assertEquals(verdict, { decision: "approve" });
    assertStringIncludes(
      stderr.join("\n"),
      "Runaway spend anomaly — hard stop",
    );
    assertFalse((stderr.join("\n")).includes("exceed budget ceiling"));
  });

  it("runaway_anomaly denies on anything but yes", async () => {
    const { io } = fakeIo([""]);
    const verdict = await promptMidTurnApproval(io, {
      kind: "runaway_anomaly",
    }, true);
    assertStrictEquals(verdict.decision, "deny");
  });
});
