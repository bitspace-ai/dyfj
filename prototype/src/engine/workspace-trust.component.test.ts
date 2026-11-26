/**
 * Instruction trust binds to the workspace a Codex turn actually launches in
 * (BIT-982).
 *
 * Route resolution answers the trust question before the paid preflight runs,
 * and the launch happens afterwards. Anything that can move the path in
 * between - a symlink swapped while the operator is looking at the approval
 * prompt, say - must not let a decision about a trusted directory carry over to
 * a declined one. This test does exactly that swap, with real temp directories
 * and a real symlink, inside the paid-approval callback.
 *
 * It runs the real engine entry (`runWorkbenchRuntime`) over the real ACP
 * runtime (`runExternalAgentWorkbenchRuntime`); only the agent process and the
 * execution profile are supplied at their declared ports, so nothing spawns.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { engineServices } from "../../testing/builders/engine.ts";
import type { AcpExecutionProfile } from "../acp-client.ts";
import type { WorkspaceConfigResolver } from "../config/mod.ts";
import { CODEX_WORKSPACE_TRUST_REQUIRED } from "../contract/mod.ts";
import { runExternalAgentWorkbenchRuntime } from "../external-agent-runtime.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";

test("a symlink swapped to a declined workspace during paid approval refuses the launch", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "dyfj-trust-")));
  const trusted = join(base, "trusted");
  const declined = join(base, "declined");
  const link = join(base, "selected");
  await mkdir(trusted);
  await mkdir(declined);
  await symlink(trusted, link);
  const run = engineServices([]);
  // The operator's profiles: the trusted directory elevates its instructions,
  // as does the selected path itself, which is what route resolution sees. The
  // directory the swap points at does not, so a decision made about the
  // selected path must not carry over to it.
  const resolver: WorkspaceConfigResolver = {
    resolve(workspace: string) {
      return {
        trustInstructions: workspace === trusted || workspace === link,
        gate: null,
        publish: null,
        sandbox: { allowDomains: [], denyRead: [] },
        requireWorktree: false,
        dispatch: null,
        profile: null,
      };
    },
  };
  const agentsRun: string[] = [];
  try {
    await assert.rejects(
      () =>
        runWorkbenchRuntime({
          mode: "turn",
          prompt: "publish this branch",
          routingOptions: {},
          runner: { kind: "acp", profile: "codex-chatgpt" },
          workspaceRoot: link,
          // The operator's global setting is on; the profile for the declined
          // directory is what declines it, so a route-time decision made about
          // the trusted directory must not carry over.
          trustWorkspaceInstructions: true,
          approver: {
            // The operator approves the paid route while the path is being
            // retargeted: the approval is about the turn, not about which
            // directory it ends up in.
            confirmPaidEscalation: async () => {
              await unlink(link);
              await symlink(declined, link);
              return { decision: "approve" };
            },
          },
        }, {
          ...run.services,
          workspaceConfig: resolver,
          externalAgentRunner: {
            run: (input) =>
              runExternalAgentWorkbenchRuntime(input, {
                store: run.store,
                resolveProfile: (_profile, workspace) =>
                  Promise.resolve({
                    slug: "codex-chatgpt",
                    command: "/nonexistent/codex-acp",
                    args: [],
                    environment: {},
                    workspace,
                    transport: "local_stdio",
                    accessRoute: "subscription_oauth",
                    costBasis: "subscription_quota",
                  } as AcpExecutionProfile),
                runAgent: (agentInput) => {
                  agentsRun.push(agentInput.profile.workspace);
                  return Promise.reject(new Error("the agent must not run"));
                },
              }),
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(CODEX_WORKSPACE_TRUST_REQUIRED),
      "the launch must be refused once the workspace resolves to a declined directory",
    );
    assert.deepStrictEqual(
      agentsRun,
      [],
      "no agent process starts for a workspace the profile declines",
    );
  } finally {
    await run.store.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("the same launch proceeds when the workspace still resolves to the trusted directory", async () => {
  // The control: without the swap, this exact composition launches, so the
  // refusal above is the revalidation and not something else in the path.
  const base = await realpath(await mkdtemp(join(tmpdir(), "dyfj-trust-")));
  const trusted = join(base, "trusted");
  const link = join(base, "selected");
  await mkdir(trusted);
  await symlink(trusted, link);
  const run = engineServices([]);
  const resolver: WorkspaceConfigResolver = {
    resolve(workspace: string) {
      return {
        trustInstructions: workspace === trusted,
        gate: null,
        publish: null,
        sandbox: { allowDomains: [], denyRead: [] },
        requireWorktree: false,
        dispatch: null,
        profile: null,
      };
    },
  };
  const agentsRun: string[] = [];
  try {
    await runWorkbenchRuntime({
      mode: "turn",
      prompt: "publish this branch",
      routingOptions: {},
      runner: { kind: "acp", profile: "codex-chatgpt" },
      workspaceRoot: link,
      trustWorkspaceInstructions: false,
      approver: { confirmPaidEscalation: async () => ({ decision: "approve" }) },
    }, {
      ...run.services,
      workspaceConfig: resolver,
      externalAgentRunner: {
        run: (input) =>
          runExternalAgentWorkbenchRuntime(input, {
            store: run.store,
            resolveProfile: (_profile, workspace) =>
              Promise.resolve({
                slug: "codex-chatgpt",
                command: "/nonexistent/codex-acp",
                args: [],
                environment: {},
                workspace,
                transport: "local_stdio",
                accessRoute: "subscription_oauth",
                costBasis: "subscription_quota",
              } as AcpExecutionProfile),
            runAgent: (agentInput) => {
              agentsRun.push(agentInput.profile.workspace);
              return Promise.resolve({
                text: "done",
                stopReason: "stop",
                capabilities: [],
                elapsedMs: 1,
              });
            },
          }),
      },
    });
    assert.deepStrictEqual(agentsRun, [trusted]);
  } finally {
    await run.store.close();
    await rm(base, { recursive: true, force: true });
  }
});
