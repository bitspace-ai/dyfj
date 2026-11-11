// Child-session start validation and turn-request helpers for `DispatchService`
// (BIT-907).

import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import { isAbsolute } from "node:path";
import type {
  CodexReasoningEffort,
  DispatchConfig,
  Env,
} from "../config/mod.ts";
import {
  CODEX_WORKSPACE_TRUST_REQUIRED,
  DomainError,
  summarizeError,
} from "../contract/mod.ts";
import type { TurnRequestBody, WorkbenchRuntimeResult } from "../engine/mod.ts";
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import {
  createProviderRegistry,
  modelReasoningEffort,
  PROVIDER_ADAPTERS,
  selectWorkbenchModel,
  type WorkbenchModel,
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "../providers/mod.ts";
import {
  AdditionalRootRefusedError,
  admitAdditionalRoots,
  type DispatchChildState,
  type DispatchStartInput,
  type DispatchStartPlan,
  modelFamilyFromCatalog,
  overlapsProtectedPath,
  pathWithin,
  protectedPaths,
  runtimePrototypeRoot,
} from "../tools/mod.ts";

const providerRegistry = createProviderRegistry(PROVIDER_ADAPTERS);

export function classifyTurnReceipt(
  result: WorkbenchRuntimeResult,
): DispatchChildState {
  if ("runner" in result) {
    if (result.runner.externalStopReason === "cancelled") return "cancelled";
    if (result.runner.externalStopReason === "refusal") return "failed";
  }
  if (result.stopReason === "aborted") return "cancelled";
  if (result.stopReason === "error") return "failed";
  return "idle";
}

export function classifyTurnFailure(
  error: unknown,
  aborted: boolean,
): DispatchChildState {
  if (aborted) return "cancelled";
  if (error instanceof Error && error.name === "AbortError") {
    return "cancelled";
  }
  return "failed";
}

export function buildChildTurnBody(input: {
  sessionId?: string;
  prompt: string;
  workspace: string;
  roots: readonly string[];
  model: string;
  route: "native" | "acp";
  effort: string | null;
  approvePaid: boolean;
}): TurnRequestBody {
  return {
    mode: "turn",
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    prompt: input.prompt,
    workspace: input.workspace,
    ...(input.roots.length === 0
      ? {}
      : {
        additionalRoots: input.roots.map((rootPath) => ({
          path: rootPath,
          readOnly: false,
        })),
      }),
    routingOptions: {
      modelId: input.model,
      ...(input.route === "acp" && input.effort !== null
        ? { reasoningEffort: input.effort }
        : {}),
    },
    approvePaidInference: input.approvePaid,
  };
}

interface ResolvedDispatchModel {
  model: WorkbenchModel;
  route: "native" | "acp";
  effort: string | null;
}

function validateDispatchModel(input: {
  catalog: WorkbenchModel[];
  requestedModel: string;
  requestedEffort: DispatchStartInput["effort"];
  approvePaid: boolean;
  trustWorkspaceInstructions: boolean;
  defaultCodexReasoningEffort: CodexReasoningEffort;
}): { resolved: ResolvedDispatchModel } | { refusal: string } {
  let model: WorkbenchModel;
  try {
    model = selectWorkbenchModel(input.catalog, {
      modelId: input.requestedModel,
    }).selected;
  } catch (error) {
    const safeSlug = sanitizeBoundaryText(input.requestedModel, 128);
    if (error instanceof WorkbenchModelNotFoundError) {
      return {
        refusal: `unknown model "${safeSlug}"; /model lists the available ones`,
      };
    }
    if (error instanceof WorkbenchModelNotRoutableError) {
      return {
        refusal: `model "${safeSlug}" is not routable: unpriced`,
      };
    }
    return {
      refusal: `model "${safeSlug}" is unavailable: ${summarizeError(error)}`,
    };
  }

  let route: "native" | "acp";
  let effort: string | null;
  if (model.api === "acp") {
    route = "acp";
    if (model.provider === "codex-chatgpt") {
      if (!input.trustWorkspaceInstructions) {
        return { refusal: CODEX_WORKSPACE_TRUST_REQUIRED };
      }
      effort = input.requestedEffort ?? input.defaultCodexReasoningEffort;
    } else if (model.slug === "fixture") {
      if (input.requestedEffort !== undefined) {
        return {
          refusal:
            `reasoning effort applies only to codex-chatgpt models, and ` +
            `"${model.slug}" is not one`,
        };
      }
      effort = null;
    } else {
      return {
        refusal: `unsupported ACP runner "${
          sanitizeBoundaryText(model.provider, 64)
        }"`,
      };
    }
  } else {
    route = "native";
    if (input.requestedEffort !== undefined) {
      return {
        refusal:
          `reasoning effort applies only to codex-chatgpt models, and ` +
          `"${model.slug}" is not one`,
      };
    }
    const adapter = providerRegistry.adapterFor(model);
    if (adapter === undefined) {
      return {
        refusal: `model "${model.slug}" is unavailable: no provider adapter`,
      };
    }
    const urlCheck = adapter.validateBaseUrl(model);
    if (!urlCheck.ok) {
      return {
        refusal: `model "${model.slug}" is unavailable: ${
          urlCheck.error.message
        }`,
      };
    }
    effort = modelReasoningEffort(model, true) ?? null;
  }

  if (model.tier > 0 && input.approvePaid !== true) {
    return {
      refusal:
        `model "${model.slug}" is a paid tier-${model.tier} model; pass ` +
        "approvePaid: true to dispatch it",
    };
  }

  return { resolved: { model, route, effort } };
}

async function resolveExistingDispatchRoots(
  configuredRoots: readonly string[],
): Promise<string[]> {
  const resolved: string[] = [];
  for (const configured of configuredRoots) {
    try {
      const canonical = await realpath(configured);
      if ((await stat(canonical)).isDirectory()) {
        resolved.push(canonical);
      }
    } catch {
      // An absent configured root matches nothing until created.
    }
  }
  return resolved;
}

async function validateDispatchPaths(input: {
  config: DispatchConfig;
  env: Env;
  workspace: string;
  roots: readonly string[] | undefined;
  occupiedWorkspaces: ReadonlySet<string>;
}): Promise<
  | { workspace: string; roots: readonly string[] }
  | { refusal: string }
> {
  const allowedRoots = await resolveExistingDispatchRoots(input.config.roots);
  if (allowedRoots.length === 0) {
    return {
      refusal: "none of the configured [dispatch].roots exist on disk",
    };
  }

  if (!isAbsolute(input.workspace)) {
    return { refusal: "workspace must be an absolute path" };
  }
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(input.workspace);
    if (!(await stat(canonicalWorkspace)).isDirectory()) {
      return { refusal: "workspace is not an accessible directory" };
    }
  } catch {
    return { refusal: "workspace is not an accessible directory" };
  }

  if (!allowedRoots.some((root) => pathWithin(root, canonicalWorkspace))) {
    return {
      refusal: "workspace resolves outside the configured [dispatch].roots",
    };
  }

  let guardedPaths: string[];
  try {
    const home = input.env.get("HOME")?.trim() || os.homedir();
    guardedPaths = await protectedPaths({
      home,
      dyfjRoot: input.env.get("DYFJ_ROOT")?.trim() || undefined,
      prototypeRoot: runtimePrototypeRoot(),
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return { refusal: error.message };
    }
    return { refusal: "protected runtime paths could not be inspected" };
  }

  if (
    guardedPaths.some((guarded) =>
      overlapsProtectedPath(canonicalWorkspace, guarded)
    )
  ) {
    return {
      refusal:
        "workspace is refused: it overlaps a path the runtime protects",
    };
  }

  if (input.occupiedWorkspaces.has(canonicalWorkspace)) {
    return {
      refusal:
        "workspace is already in use by another live child of this coordinator",
    };
  }

  let canonicalRoots: string[] = [];
  if (input.roots !== undefined && input.roots.length > 0) {
    for (const [index, rawRoot] of input.roots.entries()) {
      const position = index + 1;
      if (!isAbsolute(rawRoot)) {
        return { refusal: `roots[${index}] must be an absolute path` };
      }
      let resolvedRoot: string;
      try {
        resolvedRoot = await realpath(rawRoot);
        if (!(await stat(resolvedRoot)).isDirectory()) {
          return {
            refusal: `additional root ${position} is not an accessible directory`,
          };
        }
      } catch {
        return {
          refusal: `additional root ${position} is not an accessible directory`,
        };
      }
      if (!allowedRoots.some((allowed) => pathWithin(allowed, resolvedRoot))) {
        return {
          refusal:
            `additional root ${position} resolves outside the configured ` +
            "[dispatch].roots",
        };
      }
    }
    try {
      const admitted = await admitAdditionalRoots(
        input.roots.map((rootPath) => ({ path: rootPath, readOnly: false })),
        { primary: canonicalWorkspace, protectedPaths: guardedPaths },
      );
      canonicalRoots = admitted.map((entry) => entry.path);
    } catch (error) {
      if (error instanceof AdditionalRootRefusedError) {
        return { refusal: error.message };
      }
      return { refusal: "additional roots could not be admitted" };
    }
  }

  return { workspace: canonicalWorkspace, roots: canonicalRoots };
}

export async function planDispatchStart(options: {
  config: DispatchConfig;
  env: Env;
  input: DispatchStartInput;
  loadCatalog: () => Promise<WorkbenchModel[]>;
  occupiedWorkspaces: ReadonlySet<string>;
  trustWorkspaceInstructions: boolean;
  defaultCodexReasoningEffort: CodexReasoningEffort;
}): Promise<{ plan: DispatchStartPlan } | { refusal: string }> {
  let catalog: WorkbenchModel[];
  try {
    catalog = await options.loadCatalog();
  } catch (error) {
    return {
      refusal: `model catalog is unavailable: ${summarizeError(error)}`,
    };
  }

  const modelCheck = validateDispatchModel({
    catalog,
    requestedModel: options.input.model,
    requestedEffort: options.input.effort,
    approvePaid: options.input.approvePaid === true,
    trustWorkspaceInstructions: options.trustWorkspaceInstructions,
    defaultCodexReasoningEffort: options.defaultCodexReasoningEffort,
  });
  if ("refusal" in modelCheck) return modelCheck;

  const pathCheck = await validateDispatchPaths({
    config: options.config,
    env: options.env,
    workspace: options.input.workspace,
    roots: options.input.roots,
    occupiedWorkspaces: options.occupiedWorkspaces,
  });
  if ("refusal" in pathCheck) return pathCheck;

  const { model, route, effort } = modelCheck.resolved;
  return {
    plan: {
      label: options.input.label,
      model: model.slug,
      effort,
      route,
      family: modelFamilyFromCatalog(model),
      workspace: pathCheck.workspace,
      roots: pathCheck.roots,
      approvePaid: options.input.approvePaid === true,
    },
  };
}
