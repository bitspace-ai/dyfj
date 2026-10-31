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
