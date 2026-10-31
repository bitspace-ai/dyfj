-- Move the codex-chatgpt route to the GPT-6 generation, and retire the
-- Antigravity experiment.
--
-- SOURCED. OpenAI's Codex model list and pricing page (both read 2026-10-30),
-- the bundled catalog in openai/codex `codex-rs/models-manager/models.json` at
-- HEAD and at tag rust-v0.153.4, the rust-v0.165.0 release note, the API model
-- cards for GPT-6.1 Sol and GPT-6.1 Terra, and the npm registry listing for
-- @agentclientprotocol/codex-acp. From those sources:
--
--   The four slugs are the Codex model IDs for the current generation, and the
--   slug suffix must equal the Codex ID exactly, because the runner passes the
--   suffix through as the Codex `model` value.
--   Astra is "most capable, frontier"; 6.1 Sol is "near-Astra at lower cost"
--   and OpenAI's named replacement for GPT-5.5 on Plus/Pro/Business; 6.1 Terra
--   is "fast, efficient" with writing, vision and computer use; Luna is "most
--   efficient" for high-volume, focused coding.
--   Every one of the four advertises a Fast service tier, hence `fast-speed`.
--   All four list the Plus, Pro, Business and Team plans in
--   `available_in_plans`; Luna omits `promax`.
--   The route's context window is the one Codex reports, not the API model
--   card: 500,000 for GPT-6.1 Sol (per the docs) and GPT-6.1 Terra, 272,000
--   for Astra and Luna (per models.json). The API cards list 1,050,000 with
--   128,000 max output; the cards' output figure is the only source for
--   `max_output_tokens`, which Codex does not publish per route.
--   The 2026-10-31 canaries reported usable windows of 475,000 for Sol and
--   Terra and 258,400 for Astra and Luna. Each is exactly 95% of its row
--   window (inferred usable-window fraction), supporting Sol's documented
--   500,000 window; its bundled catalog value of 272,000 was stale.
--   The predecessor adapter pin (codex-acp 1.11.0 / @openai/codex 0.153.4)
--   bundled only gpt-6-astra. codex-acp 2.5.0 depends on @openai/codex
--   ^0.165.0, which is the release that added GPT-6.1 Terra, so the client-
--   version prerequisite the draft identified is met at the adapter version
--   this tree pins. Whether a given account can use a row is the plan's and
--   the workspace admin's business (Enterprise and Edu keep 6.1 Sol off until
--   an admin enables it).
--
-- INFERRED, not sourced. Each new row copies these fields from the gpt-5.6-*
-- siblings rather than from a provider statement: provider 'codex-chatgpt',
-- api 'acp', base_url 'acp', costs all 0 (the route is billed by subscription,
-- and receipts already state "USD cost not reported"), reasoning,
-- reasoning_effort_control, the capabilities set, and the NULL architecture
-- columns. Tier is 2 for Astra, Sol and Terra to match the siblings; Luna is
-- tier 1, inferred from its "most efficient" positioning rather than stated.
-- Prices, plan limits and the per-model message estimates behind the plan
-- tier are in schema/catalog/VERIFICATION-2026-10-31.md.
--
-- The three removals are DELETE, not active = FALSE, as in migration 020:
-- nothing in schema/ declares a foreign key to models, and events name a
-- model by slug in a text column, so an older event keeps naming a slug that
-- is no longer in the catalog; the read paths tolerate a missing slug.
--   codex-chatgpt/gpt-5.6-sol      <- codex-chatgpt/gpt-6.1-sol
--   codex-chatgpt/gpt-5.6-terra    <- codex-chatgpt/gpt-6.1-terra
--   gemini-antigravity/gemini-3.7-flash, an experiment on a route with no
--     successor row, retired 2026-10-31.
--
-- Kept as-is: the claude-opus-5 and claude-fable-5 rows are stale, but
-- correcting them needs price verification that this change does not carry.
--
-- Tier semantics unchanged from 006: 0 local / 1 API light / 2 API heavy.

INSERT INTO models (
    slug,
    display_name,
    provider,
    api,
    base_url,
    tier,
    context_window,
    max_output_tokens,
    cost_input,
    cost_output,
    cost_cache_read,
    cost_cache_write,
    reasoning,
    capabilities,
    architecture,
    total_params_b,
    active_params_b,
    recommended_quant,
    resident_ram_gib,
    reasoning_effort_control,
    active
) VALUES (
    'codex-chatgpt/gpt-6-astra',
    'GPT-6 Astra (Codex)',
    'codex-chatgpt',
    'acp',
    'acp',
    2,
    272000,
    128000,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context","fast-speed"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
),
(
    'codex-chatgpt/gpt-6.1-sol',
    'GPT-6.1 Sol (Codex)',
    'codex-chatgpt',
    'acp',
    'acp',
    2,
    500000,
    128000,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context","fast-speed"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
),
(
    'codex-chatgpt/gpt-6.1-terra',
    'GPT-6.1 Terra (Codex)',
    'codex-chatgpt',
    'acp',
    'acp',
    2,
    500000,
    128000,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context","fast-speed"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
),
(
    'codex-chatgpt/gpt-6-luna',
    'GPT-6 Luna (Codex)',
    'codex-chatgpt',
    'acp',
    'acp',
    1,
    272000,
    128000,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context","fast-speed"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
)
ON DUPLICATE KEY UPDATE
    `display_name` = VALUES(`display_name`),
    `provider` = VALUES(`provider`),
    `api` = VALUES(`api`),
    `base_url` = VALUES(`base_url`),
    `tier` = VALUES(`tier`),
    `context_window` = VALUES(`context_window`),
    `max_output_tokens` = VALUES(`max_output_tokens`),
    `cost_input` = VALUES(`cost_input`),
    `cost_output` = VALUES(`cost_output`),
    `cost_cache_read` = VALUES(`cost_cache_read`),
    `cost_cache_write` = VALUES(`cost_cache_write`),
    `reasoning` = VALUES(`reasoning`),
    `capabilities` = VALUES(`capabilities`),
    `architecture` = VALUES(`architecture`),
    `total_params_b` = VALUES(`total_params_b`),
    `active_params_b` = VALUES(`active_params_b`),
    `recommended_quant` = VALUES(`recommended_quant`),
    `resident_ram_gib` = VALUES(`resident_ram_gib`),
    `reasoning_effort_control` = VALUES(`reasoning_effort_control`);
-- `active` is deliberately absent above, as in migration 020. A fresh row
-- takes the INSERT value, but where a slug already exists its active state is
-- the installation's choice: an operator may have disabled the model on
-- purpose, and re-running this migration must not route traffic back to it.

DELETE FROM models WHERE slug IN (
    'codex-chatgpt/gpt-5.6-sol',
    'codex-chatgpt/gpt-5.6-terra',
    'gemini-antigravity/gemini-3.7-flash'
);
