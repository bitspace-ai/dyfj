-- Add DeepSeek V4.1 Flash (OpenRouter) and Gemini 3.8 Flash (Google direct) to
-- the model catalog.
--
-- Prices verified 2026-09-19. Per-million USD. Sources, captured figures and
-- the dates behind them are in schema/catalog/VERIFICATION-2026-09-19.md,
-- including which fields come from the routed provider and which are
-- corroborated from elsewhere.
--
-- DeepSeek, from the OpenRouter catalog, which is the provider this row
-- reaches: in $0.30 / out $1.20 / cache read $0.006. Context 1,048,576,
-- output limit 384,000.
--
-- Those are PEAK prices. DeepSeek V4.1 Flash is priced by time of day: half
-- these rates at most hours and all weekend, doubling for seven hours of every
-- weekday (01:00-04:00 and 06:00-10:00 UTC). A row holds one number, so this
-- records the higher one, and outside those seven hours the real charge is
-- half what the catalog says. That choice is not free: a consumer enforcing a
-- spending limit may refuse an off-peak request it could have afforded.
-- Refusing an affordable request is recoverable; spending past a limit the
-- operator set is not.
--
-- Gemini input, output and cache read come from Google's own pricing page,
-- since this row routes to Google directly: in $0.75 / out $3.75 / cache read
-- $0.075. Its context window and output limit are not stated there and come
-- from the aggregator listing of the same model.
--
-- Gemini cache write is 0, meaning not published in this form rather than
-- free. Google charges cache STORAGE per hour ($0.50 per million tokens per
-- hour), which is duration-dependent and has no column here. The aggregator
-- publishes a per-token write price for the same model, but a per-token write
-- charge and an hourly storage charge are different kinds of price, and this
-- row bills against Google directly.
--
-- The Gemini row omits "tools" from its capabilities, departing from the
-- sibling 3.6 and 3.7 Flash rows which list it. The Google adapter here cannot
-- carry a tool call: buildGeminiRequest in prototype/src/provider.ts sends no
-- tool declarations, and functionCall appears nowhere in that file, so the
-- catalog should not advertise native tool support.
--
-- This is metadata only. Nothing reads the field when choosing a model: the
-- only capability-gated selections in prototype/src test for "fast-speed" and
-- "code". A caller naming this model for tool-using work still gets it.
--
-- The column otherwise describes the model rather than the reachable surface,
-- which is why "vision" stays: the adapter builds text-only parts and cannot
-- send an image either. Whether this column should mean vendor capability or
-- reachable capability is a catalog-wide question; see
-- schema/catalog/VERIFICATION-2026-09-19.md.
--
-- The Gemini prices above are promotional. Google lists them as holding
-- through 2026-12-31 and doubling on 2027-01-01 to in $1.50 / out $7.50 /
-- cache read $0.15. The catalog has no validity window, so these rows will be
-- wrong from that date until someone updates them.
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
    'deepseek/deepseek-v4.1-flash',
    'DeepSeek V4.1 Flash',
    'openrouter',
    'openai-completions',
    'https://openrouter.ai/api/v1',
    1,
    1048576,
    384000,
    0.300000,
    1.200000,
    0.006000,
    0.000000,
    TRUE,
    '["text","code","reasoning","long-context"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    FALSE,
    TRUE
),
(
    'gemini-3.8-flash',
    'Gemini 3.8 Flash',
    'google',
    'google-generative-ai',
    'https://generativelanguage.googleapis.com',
    1,
    1048576,
    65536,
    0.750000,
    3.750000,
    0.075000,
    0.000000,
    TRUE,
    '["text","code","reasoning","vision","thinking","long-context"]',
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
-- `active` is deliberately absent above. A fresh row takes the INSERT value,
-- but where either slug already exists its active state is the installation's
-- choice: an operator may have disabled the model on purpose, and re-running
-- this migration must not route traffic back to it. Migration 010 exists
-- because active states drifted once already.
