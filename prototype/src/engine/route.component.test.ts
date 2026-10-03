/**
 * Component test for route resolution: `resolveRoute` and `selectModelRoute`
 * over a `MemoryStore` catalog, with the consent handler as a spy. Covers the
 * runner choice for native and ACP routes, the ACP workspace-trust and paid
 * preflight checks, and the catalog-failure behavior of both entry points.
 */

import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy, stub } from "@std/testing/mock";
import { MemoryStore, type ModelSeed } from "../store/mod.ts";
import { DomainError, type PaidEscalationVerdict } from "../contract/mod.ts";
import {
  WorkbenchModelNotFoundError,
  type WorkbenchRoutingOptions,
} from "../providers/mod.ts";
import { PaidEscalationDeclinedError } from "./errors.ts";
import {
  resolveRoute,
  type RouteModelReader,
  type RouteRequest,
  selectModelRoute,
} from "./route.ts";

const LOCAL: ModelSeed = {
  slug: "local-small",
  display_name: "Local Small",
  provider: "ollama",
  api: "openai-completions",
  base_url: "http://127.0.0.1:11434/v1",
  tier: 0,
  context_window: 32768,
  max_output_tokens: 4096,
  capabilities: ["text"],
};

const ACP_FIXTURE: ModelSeed = {
  slug: "fixture",
  display_name: "ACP Fixture",
  provider: "fixture",
  api: "acp",
  base_url: "local_stdio",
  tier: 0,
  context_window: 32768,
  max_output_tokens: 4096,
  capabilities: ["text"],
};

const CODEX_TERRA: ModelSeed = {
  slug: "codex-chatgpt/gpt-5.6-terra",
  display_name: "GPT-5.6 Terra",
  provider: "codex-chatgpt",
  api: "acp",
  base_url: "local_stdio",
  tier: 2,
  cost_input: 1.25,
  cost_output: 10,
  context_window: 1050000,
  max_output_tokens: 128000,
  capabilities: ["text", "fast-speed"],
};

const UNSUPPORTED_ACP: ModelSeed = {
  slug: "other-agent",
  display_name: "Other Agent",
  provider: "other-agent",
  api: "acp",
  base_url: "local_stdio",
  tier: 0,
  context_window: 32768,
  max_output_tokens: 4096,
  capabilities: ["text"],
};

function catalog(...models: ModelSeed[]): RouteModelReader {
  return new MemoryStore({ models }).models;
}

const failingCatalog: RouteModelReader = {
  listActive: () => Promise.reject(new Error("registry unavailable")),
  listInactiveSlugs: () => Promise.reject(new Error("registry unavailable")),
};

function consent(value: PaidEscalationVerdict) {
  return spy((_banner: string) => Promise.resolve(value));
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { routingOptions: {}, ...overrides };
}

// ── resolveRoute: explicit ACP runner ────────────────────────────────────────

Deno.test("resolveRoute returns an explicit fixture runner without consent or catalog", async () => {
  const confirm = consent({ decision: "deny" });
  const routingOptions: WorkbenchRoutingOptions = { hint: "code" };
  const route = await resolveRoute(
    request({
      routingOptions,
      runner: { kind: "acp", profile: "fixture" },
      approver: {
        confirmPaidEscalation: confirm,
      },
    }),
    failingCatalog,
  );
  assertEquals(route.runner, "acp");
  if (route.runner !== "acp") return;
  assertEquals(route.selection, { kind: "acp", profile: "fixture" });
  assertStrictEquals(route.routingOptions, routingOptions);
  assertSpyCalls(confirm, 0);
});

Deno.test("resolveRoute rejects an explicit Codex ChatGPT runner without workspace trust, before consent", async () => {
  const confirm = consent({ decision: "approve" });
  await assertRejects(
    () =>
      resolveRoute(
        request({
          runner: { kind: "acp", profile: "codex-chatgpt" },
          trustWorkspaceInstructions: false,
          approver: {
            confirmPaidEscalation: confirm,
          },
        }),
        catalog(LOCAL),
      ),
    DomainError,
    "codex-chatgpt requires explicit workspace trust",
  );
  assertSpyCalls(confirm, 0);
});

Deno.test("resolveRoute asks paid consent for an explicit Codex ChatGPT runner against the default limits", async () => {
  const confirm = consent({ decision: "deny", reason: "not today" });
  await assertRejects(
    () =>
      resolveRoute(
        request({
          runner: { kind: "acp", profile: "codex-chatgpt" },
          trustWorkspaceInstructions: true,
          defaultSessionBudgetUsd: 2,
          defaultPerCallBudgetUsd: 0.25,
          approver: {
            confirmPaidEscalation: confirm,
          },
        }),
        catalog(LOCAL),
      ),
    PaidEscalationDeclinedError,
    "Paid inference consent declined: not today",
  );
  assertSpyCalls(confirm, 1);
  const banner = confirm.calls[0].args[0];
  assertStringIncludes(
    banner,
    "Model:           GPT-5.6 Terra (Codex) (codex-chatgpt/gpt-5.6-terra)",
  );
  assertStringIncludes(banner, "Tier:            2");
  assertStringIncludes(banner, "Route:           explicit_runner");
  assertStringIncludes(banner, "Estimated cost:  $0.000000");
  assertStringIncludes(banner, "Session spent:   $0.000000 / $2.000000");
  assertStringIncludes(banner, "Per-call limit:  $0.250000");
});

Deno.test("resolveRoute denies an explicit Codex ChatGPT runner when no consent handler is configured", async () => {
  await assertRejects(
    () =>
      resolveRoute(
        request({
          runner: { kind: "acp", profile: "codex-chatgpt" },
          trustWorkspaceInstructions: true,
        }),
        catalog(LOCAL),
      ),
    PaidEscalationDeclinedError,
    "no consent handler configured",
  );
});

Deno.test("resolveRoute returns an approved explicit Codex ChatGPT runner", async () => {
  const route = await resolveRoute(
    request({
      runner: { kind: "acp", profile: "codex-chatgpt" },
      trustWorkspaceInstructions: true,
      approver: {
        confirmPaidEscalation: consent({ decision: "approve" }),
      },
    }),
    catalog(LOCAL),
  );
  assertEquals(route, {
    runner: "acp",
    selection: { kind: "acp", profile: "codex-chatgpt" },
    routingOptions: {},
  });
});

// ── resolveRoute: catalog selection ──────────────────────────────────────────

Deno.test("resolveRoute keeps a native catalog selection on the native runner", async () => {
  const confirm = consent({ decision: "deny" });
  const route = await resolveRoute(
    request({
      approver: { confirmPaidEscalation: confirm },
    }),
    catalog(LOCAL, ACP_FIXTURE),
  );
  assertEquals(route, { runner: "native" });
  assertSpyCalls(confirm, 0);
});

Deno.test("resolveRoute routes a selected fixture ACP model to the fixture runner with its slug pinned", async () => {
  const route = await resolveRoute(
    request({ routingOptions: { modelId: "fixture", hint: "code" } }),
    catalog(LOCAL, ACP_FIXTURE),
  );
  assertEquals(route, {
    runner: "acp",
    selection: { kind: "acp", profile: "fixture" },
    routingOptions: { modelId: "fixture", hint: "code" },
  });
});

Deno.test("resolveRoute routes a configured default ACP model and pins its slug", async () => {
  const route = await resolveRoute(
    request({ defaultCompanionModel: "fixture" }),
    catalog(LOCAL, ACP_FIXTURE),
  );
  assertEquals(route, {
    runner: "acp",
    selection: { kind: "acp", profile: "fixture" },
    routingOptions: { modelId: "fixture" },
  });
});

Deno.test("resolveRoute rejects a selected Codex ChatGPT model without workspace trust, before consent", async () => {
  const confirm = consent({ decision: "approve" });
  await assertRejects(
    () =>
      resolveRoute(
        request({
          routingOptions: { modelId: CODEX_TERRA.slug },
          approver: {
            confirmPaidEscalation: confirm,
          },
        }),
        catalog(LOCAL, CODEX_TERRA),
      ),
    DomainError,
    "codex-chatgpt requires explicit workspace trust",
  );
  assertSpyCalls(confirm, 0);
});

Deno.test("resolveRoute asks paid consent for a selected tier-2 ACP model with its selection reason", async () => {
  const confirm = consent({ decision: "escalate" });
  await assertRejects(
    () =>
      resolveRoute(
        request({
          routingOptions: { modelId: CODEX_TERRA.slug },
          trustWorkspaceInstructions: true,
          approver: {
            confirmPaidEscalation: confirm,
          },
        }),
        catalog(LOCAL, CODEX_TERRA),
      ),
    PaidEscalationDeclinedError,
    "Paid inference escalation required",
  );
  assertSpyCalls(confirm, 1);
  const banner = confirm.calls[0].args[0];
  assertStringIncludes(
    banner,
    "Model:           GPT-5.6 Terra (codex-chatgpt/gpt-5.6-terra)",
  );
  assertStringIncludes(banner, "Route:           explicit_model_id");
});

Deno.test("resolveRoute returns an approved selected Codex ChatGPT model", async () => {
  const route = await resolveRoute(
    request({
      routingOptions: { modelId: CODEX_TERRA.slug },
      trustWorkspaceInstructions: true,
      approver: {
        confirmPaidEscalation: consent({ decision: "approve" }),
      },
    }),
    catalog(LOCAL, CODEX_TERRA),
  );
  assertEquals(route, {
    runner: "acp",
    selection: { kind: "acp", profile: "codex-chatgpt" },
    routingOptions: { modelId: CODEX_TERRA.slug },
  });
});

Deno.test("resolveRoute rejects an ACP model no runner profile serves", async () => {
  await assertRejects(
    () =>
      resolveRoute(
        request({ routingOptions: { modelId: UNSUPPORTED_ACP.slug } }),
        catalog(LOCAL, UNSUPPORTED_ACP),
      ),
    DomainError,
    "Unsupported ACP runner: other-agent",
  );
});

Deno.test("resolveRoute propagates a routing error for an unknown model", async () => {
  await assertRejects(
    () =>
      resolveRoute(
        request({ routingOptions: { modelId: "missing" } }),
        catalog(LOCAL),
      ),
    WorkbenchModelNotFoundError,
  );
});

Deno.test("resolveRoute falls back to the native runner when the catalog cannot be loaded", async () => {
  // Characterizes current behavior: a registry load failure is swallowed
  // here, selection runs over the static local defaults, and the native turn
  // reports its own failure (see specs/bug-log.md).
  const route = await resolveRoute(request(), failingCatalog);
  assertEquals(route, { runner: "native" });
});

Deno.test("resolveRoute still propagates a routing error over the fallback catalog", async () => {
  await assertRejects(
    () =>
      resolveRoute(
        request({ routingOptions: { modelId: "fixture" } }),
        failingCatalog,
      ),
    WorkbenchModelNotFoundError,
  );
});

// ── selectModelRoute ─────────────────────────────────────────────────────────

Deno.test("selectModelRoute selects over the catalog and reports the selection reason", async () => {
  const route = await selectModelRoute(catalog(LOCAL), {
    mode: "turn",
    routingOptions: {},
  });
  assertEquals(route.selection.selected.slug, LOCAL.slug);
  assertEquals(route.routingReason, "default");
  assertEquals(route.models.map((model) => model.slug), [LOCAL.slug]);
});

Deno.test("selectModelRoute names the local default for a next-work turn", async () => {
  const route = await selectModelRoute(catalog(LOCAL), {
    mode: "next-work",
    routingOptions: {},
  });
  assertEquals(route.routingReason, "default_local_next_work");
});

Deno.test("selectModelRoute honors the configured default companion model", async () => {
  const route = await selectModelRoute(catalog(LOCAL, ACP_FIXTURE), {
    mode: "turn",
    routingOptions: {},
    defaultCompanionModel: "fixture",
  });
  assertEquals(route.selection.selected.slug, "fixture");
  assertEquals(route.routingReason, "default_config");
});

Deno.test("selectModelRoute fails a companion turn when the catalog cannot be loaded", async () => {
  await assertRejects(
    () =>
      selectModelRoute(failingCatalog, { mode: "turn", routingOptions: {} }),
    Error,
    "registry unavailable",
  );
});

Deno.test("selectModelRoute falls back to the static local default for an ask turn", async () => {
  const warn = stub(console, "warn");
  try {
    const route = await selectModelRoute(failingCatalog, {
      mode: "ask",
      routingOptions: {},
    });
    assertEquals(route.selection.selected.tier, 0);
    assertEquals(route.routingReason, "default");
  } finally {
    warn.restore();
  }
  assertSpyCalls(warn, 1);
  assertStringIncludes(
    String(warn.calls[0].args[0]),
    "Model registry unavailable; using static local Tier 0 default",
  );
});

Deno.test("selectModelRoute does not restore a built-in default the catalog marks inactive", async () => {
  const route = await selectModelRoute(
    catalog(LOCAL, { ...LOCAL, slug: "qwen3.6:35b-a3b", active: false }),
    { mode: "ask", routingOptions: {} },
  );
  assertEquals(
    route.models.some((model) => model.slug === "qwen3.6:35b-a3b"),
    false,
  );
  assertEquals(route.selection.selected.slug === "qwen3.6:35b-a3b", false);
});
