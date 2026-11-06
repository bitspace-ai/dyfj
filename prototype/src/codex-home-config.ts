import { opendir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AcpPermissionPrompt,
  type AcpPermissionSelection,
  DomainError,
} from "./contract/mod.ts";

/**
 * Codex features this route turns off. With a ChatGPT sign-in, Codex's
 * defaults expose every app connected to that account as a tool (mail,
 * banking, GitHub merges, deploys), and plugins can add more. None of that
 * belongs in a Workbench coding session, and those tools act outside the
 * runtime's own approvals, so the runtime sets both features to `false`.
 */
export const CODEX_DISABLED_FEATURES = { apps: false, plugins: false } as const;

/**
 * The dedicated Codex home's `config.toml`, rewritten on every launch so the
 * app-server reads the disabled features at startup, before any session's
 * own configuration applies. The file is Workbench's alone: an operator's
 * edits to it are overwritten.
 */
export const CODEX_HOME_CONFIG_TOML = "[features]\n" +
  Object.entries(CODEX_DISABLED_FEATURES)
    .map(([key, value]) => `${key} = ${String(value)}\n`)
    .join("");

/**
 * Refuse the route if, when checked at launch, the Codex home's `rules`
 * directory holds any entry. Codex loads the `*.rules` files there when it
 * starts a session. A file written there after this check is not caught. A rule that
 * allows a command makes Codex run that command outside its sandbox without
 * asking for approval, so Workbench never sees the request. Codex saves such a
 * rule when a "don't ask again" approval option is chosen. The app-server
 * that codex-acp starts has no setting to ignore the directory.
 */
export async function refuseCodexCommandRules(codexHome: string) {
  let empty: boolean;
  try {
    // Read one entry: a single entry is enough to refuse.
    const directory = await opendir(join(codexHome, "rules"));
    try {
      empty = (await directory.read()) === null;
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw new DomainError("Codex ACP command rules directory is unreadable");
  }
  if (empty) return;
  throw new DomainError(
    "The Codex rules directory .dyfj/runner-homes/codex-chatgpt/home/.codex/rules " +
      "under the operator home is not empty. A rule there can let Codex run a " +
      "command outside its sandbox without Workbench approval, so the route " +
      "refuses to start without reading the rules. Review and remove that " +
      "directory's contents, then retry",
  );
}

/**
 * The codex-acp 2.5.0 permission option IDs that save an approval for later
 * sessions: as a Codex command rule, as a network policy (`…:<n>`), or as an
 * MCP tool's "always allow". Workbench withholds these on the Codex route. An
 * option whose ID neither equals a listed ID nor starts with one followed by
 * `:` passes through unchanged.
 */
export const CODEX_SAVED_APPROVAL_OPTION_IDS = [
  "accept_execpolicy_amendment",
  "apply_network_policy_amendment",
  "allow_always",
] as const;

function savesApproval(optionId: string): boolean {
  return CODEX_SAVED_APPROVAL_OPTION_IDS.some((id) =>
    optionId === id || optionId.startsWith(`${id}:`)
  );
}

type ConfirmPermission = (
  prompt: AcpPermissionPrompt,
  signal: AbortSignal,
) => Promise<AcpPermissionSelection>;

/**
 * The operator's confirmation for a turn on `profile`. On the Codex route it
 * drops the options in CODEX_SAVED_APPROVAL_OPTION_IDS from the prompt, and
 * answers a selection of one with no option, which the ACP client turns into
 * a rejection.
 */
export function withholdSavedApprovals(
  profile: { slug: string },
  approver?: { confirmExternalAgentPermission?: ConfirmPermission },
): ConfirmPermission | undefined {
  const confirm = approver?.confirmExternalAgentPermission;
  if (confirm === undefined || profile.slug !== "codex-chatgpt") return confirm;
  return async (prompt, signal) => {
    const options = prompt.options.filter((o) => !savesApproval(o.optionId));
    const selection = await confirm({ ...prompt, options }, signal);
    return selection.optionId !== null && savesApproval(selection.optionId)
      ? { ...selection, optionId: null }
      : selection;
  };
}
