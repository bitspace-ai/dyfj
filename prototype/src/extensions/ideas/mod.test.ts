import assert from "node:assert/strict";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import {
  createIdeaPacketExtensions,
  type IdeaPacketExtensionDeps,
} from "./mod.ts";

// Both extensions' methods over one fresh pair, as the composition root
// builds them.
function handlers(overrides: Partial<IdeaPacketExtensionDeps> = {}) {
  const deps: IdeaPacketExtensionDeps = {
    fetchSessionEvents: (input) =>
      Promise.resolve(
        [{
          id: "e1",
          sessionId: input.sessionId,
        }] as unknown as WorkbenchSessionEvent[],
      ),
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: false, workspace: null }),
    ...overrides,
  };
  const [ideas, packets] = createIdeaPacketExtensions();
  return { ...ideas.rpc(deps), ...packets.rpc(deps) };
}

Deno.test("the pair is the ideas and packets extensions with their methods", () => {
  const [ideas, packets] = createIdeaPacketExtensions();
  const deps: IdeaPacketExtensionDeps = {
    fetchSessionEvents: () => Promise.resolve([]),
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: false, workspace: null }),
  };
  assert.deepStrictEqual(ideas.id, "ideas");
  assert.deepStrictEqual(Object.keys(ideas.rpc(deps)), [
    "ideas/mark",
    "ideas/list",
    "ideas/get",
  ]);
  assert.deepStrictEqual(packets.id, "packets");
  assert.deepStrictEqual(Object.keys(packets.rpc(deps)), [
    "packets/draft",
    "packets/list",
    "packets/get",
  ]);
});

Deno.test("ideas/mark, ideas/list, ideas/get flow", async () => {
  const rpc = handlers({
    fetchSessionEvents: () =>
      Promise.resolve([
        {
          eventId: "evt-idea-1",
          sessionId: "01TEST_IDEA_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Let us capture candidate work items as ideas.",
        },
      ] as unknown as WorkbenchSessionEvent[]),
  });
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId: "01TEST_IDEA_SESSION",
    eventId: "evt-idea-1",
    label: "Capture ideas",
  }) as { idea: { ideaId: string; label: string; description: string } };
  assert.deepStrictEqual(idea.label, "Capture ideas");
  assert.deepStrictEqual(
    idea.description,
    "Let us capture candidate work items as ideas.",
  );

  const { ideas } = await callRpc(rpc, "ideas/list", {
    sessionId: "01TEST_IDEA_SESSION",
  }) as { ideas: Array<{ ideaId: string }> };
  assert.deepStrictEqual(ideas.map((entry) => entry.ideaId), [idea.ideaId]);

  const got = await callRpc(rpc, "ideas/get", { ideaId: idea.ideaId }) as {
    idea: { ideaId: string };
  };
  assert.deepStrictEqual(got.idea.ideaId, idea.ideaId);
});

Deno.test("packets/draft, packets/list, packets/get flow", async () => {
  const rpc = handlers({
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: true, workspace: "/workspaces/project" }),
    fetchSessionEvents: () =>
      Promise.resolve([
        {
          eventId: "evt-pk-1",
          sessionId: "01TEST_PACKET_SESSION",
          eventType: "model_response",
          createdAt: "2026-08-15T12:00:00Z",
          content: "Drafting bounded work packets.",
        },
      ] as unknown as WorkbenchSessionEvent[]),
  });
  const draft = await callRpc(rpc, "packets/draft", {
    sessionId: "01TEST_PACKET_SESSION",
    issueId: "ISSUE-258",
    title: "Neutral session model",
    operatorIntent: "Deliver Milestone 3 Packet 0",
  }) as {
    packet: { packetId: string; issueId: string; targetWorkspace: string };
    markdown: string;
  };
  assert.deepStrictEqual(draft.packet.issueId, "ISSUE-258");
  assert.deepStrictEqual(draft.packet.targetWorkspace, "/workspaces/project");
  assert.ok(draft.markdown.includes("# Work Packet: Neutral session model"), `expected draft.markdown to include "# Work Packet: Neutral session model"`);
  assert.ok(draft.markdown.includes("- **Related Issue:** `ISSUE-258`"), `expected draft.markdown to include "- **Related Issue:** \`ISSUE-258\`"`);

  const { packets } = await callRpc(rpc, "packets/list", {
    sessionId: "01TEST_PACKET_SESSION",
  }) as { packets: Array<{ packetId: string }> };
  assert.deepStrictEqual(packets.map((entry) => entry.packetId), [draft.packet.packetId]);

  const got = await callRpc(rpc, "packets/get", {
    packetId: draft.packet.packetId,
  }) as { packet: { packetId: string }; markdown: string };
  assert.deepStrictEqual(got.packet.packetId, draft.packet.packetId);
  assert.ok(got.markdown.includes("# Work Packet: Neutral session model"), `expected got.markdown to include "# Work Packet: Neutral session model"`);
});

Deno.test("ideas and packets share the pair's registry; another pair has its own", async () => {
  const sessionId = "01OWNED_REGISTRY_SESSION";
  const rpc = handlers();
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId,
    label: "Owned registry",
  }) as { idea: { ideaId: string } };
  const draft = await callRpc(rpc, "packets/draft", {
    sessionId,
    ideaId: idea.ideaId,
  }) as { packet: { ideaId: string } };
  assert.deepStrictEqual(draft.packet.ideaId, idea.ideaId);
  // A second pair (a second engine) starts empty: no process-wide registry.
  const { ideas } = await callRpc(handlers(), "ideas/list", { sessionId }) as {
    ideas: unknown[];
  };
  assert.deepStrictEqual(ideas, []);
});

Deno.test("packets/draft rejects whitespace-only optional issueId", async () => {
  assert.deepStrictEqual(
    await rpcFailure(handlers(), "packets/draft", {
      sessionId: "01TEST_PACKET_SESSION",
      issueId: "   ",
      title: "Neutral session model",
    }),
    {
      code: RpcErrorCode.invalidParams,
      message: "issueId cannot be empty or whitespace-only",
    },
  );
});

Deno.test("ideas/mark strips complete ANSI CSI escape sequences from the label", async () => {
  const { idea } = await callRpc(handlers(), "ideas/mark", {
    sessionId: "01TEST_ANSI_SESSION",
    label: "Clean \x1b[31mRed\x1b[0m Text",
  }) as { idea: { label: string } };
  assert.deepStrictEqual(idea.label, "Clean Red Text");
  assert.ok(!idea.label.includes("[31m"));
});

Deno.test("ideas/list and packets/list reject missing sessionId", async () => {
  for (const method of ["ideas/list", "packets/list"]) {
    assert.deepStrictEqual(await rpcFailure(handlers(), method, {}), {
      code: RpcErrorCode.invalidParams,
      message: "sessionId is required",
    });
  }
});

Deno.test("packets/draft rejects idea belonging to a different session before fetching context", async () => {
  let fetches = 0;
  const rpc = handlers({
    fetchSessionEvents: () => {
      fetches++;
      return Promise.resolve([]);
    },
  });
  const { idea } = await callRpc(rpc, "ideas/mark", {
    sessionId: "01SESSION_OWNER_A",
    label: "Idea in A",
  }) as { idea: { ideaId: string } };
  const fetchesAfterMark = fetches;
  const error = await rpcFailure(rpc, "packets/draft", {
    sessionId: "01SESSION_OWNER_B",
    ideaId: idea.ideaId,
  });
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
  assert.ok(error.message.includes('belongs to session "01SESSION_OWNER_A"'), `expected error.message to include 'belongs to session "01SESSION_OWNER_A"'`);
  assert.deepStrictEqual(fetches, fetchesAfterMark);
});
