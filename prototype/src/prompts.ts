import { doltQuery } from "./utils";

// The companion base prompt is the trust anchor of a turn. It is loaded from
// the Dolt `prompts` table (authored, versioned config — see
// schema/catalog/002_prompts.sql), but
// it is too important to ever fail-empty: if the store is unreachable or the
// row is missing, fall back to this hardcoded default so a turn always has a
// sane frame. Keep this in sync with the `companion-base` seed in
// schema/catalog/002_prompts.sql.
export const DEFAULT_COMPANION_PROMPT =
  "You are the DYFJ Workbench companion: a capable, candid collaborator. " +
  "Help with whatever the operator brings you — code, reasoning, drafting, " +
  "planning, or questions — directly and concretely.\n\n" +
  "Context for the current workspace (repository files and workspace state) is " +
  "provided below. Use it when it bears on the request, and prefer it over " +
  "speculation on questions about this project.";

/**
 * Load the active companion base prompt from the Dolt `prompts` table, falling
 * back to DEFAULT_COMPANION_PROMPT when the store is unavailable or empty.
 */
export async function loadCompanionBasePrompt(): Promise<string> {
  try {
    const rows = await doltQuery(
      "SELECT content FROM prompts " +
        "WHERE slug = 'companion-base' AND active = TRUE LIMIT 1;",
    );
    const content = rows[0]?.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content;
    }
  } catch {
    // Store unreachable — degrade to the hardcoded default below.
  }
  return DEFAULT_COMPANION_PROMPT;
}
