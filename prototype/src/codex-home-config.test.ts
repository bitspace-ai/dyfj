import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AcpPermissionPrompt } from "./contract/mod.ts";
import { withholdSavedApprovals } from "./codex-home-config.ts";

const prompt: AcpPermissionPrompt = {
  sessionId: "s",
  toolCallId: "acp-permission-1",
  toolCall: { title: "git commit", inputSummary: "git commit" },
  options: [
    { optionId: "allow_once", name: "Yes", kind: "allow_once" },
    { optionId: "allow_for_session", name: "Session", kind: "allow_always" },
    {
      optionId: "accept_execpolicy_amendment",
      name: "Yes, and don't ask again",
      kind: "allow_always",
    },
    {
      optionId: "apply_network_policy_amendment:0",
      name: "Allow this host in the future",
      kind: "allow_always",
    },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "decline", name: "No", kind: "reject_once" },
  ],
};

describe("withholdSavedApprovals", () => {
  it("never offers or returns a listed Codex option that saves an approval", async () => {
    const offered: string[][] = [];
    for (const chosen of ["accept_execpolicy_amendment", "allow_once"]) {
      const confirm = withholdSavedApprovals({ slug: "codex-chatgpt" }, {
        confirmExternalAgentPermission: async (p) => {
          offered.push(p.options.map((o) => o.optionId));
          return { optionId: chosen, source: "operator" };
        },
      });
      const selection = await confirm!(prompt, new AbortController().signal);
      assert.equal(
        selection.optionId,
        chosen === "allow_once" ? "allow_once" : null,
      );
    }
    assert.deepEqual(offered[0], ["allow_once", "allow_for_session", "decline"]);
  });

  it("leaves other routes and an absent approver unchanged", () => {
    const confirmExternalAgentPermission = async () => ({ optionId: "x" });
    assert.equal(
      withholdSavedApprovals({ slug: "fixture" }, {
        confirmExternalAgentPermission,
      }),
      confirmExternalAgentPermission,
    );
    assert.equal(withholdSavedApprovals({ slug: "codex-chatgpt" }), undefined);
  });
});
