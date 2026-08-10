import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  type AcpExecutionProfile,
  type AcpPermissionVerdict,
  type AcpRouteEvidence,
  AcpProtocolMessageLimitError,
  AcpSessionUpdateLimitError,
  assertAcpPromptWithinLimit,
  runAcpAgent,
} from "./acp-client";
import {
  type ExternalAgentWorkbenchRuntimeResult,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  workspaceRootForTransport,
} from "./workbench";
import {
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createWorkbenchSession,
  fetchWorkbenchSessionWorkspaceRecord,
  updateWorkbenchSession,
} from "./sessions";
import {
  generateSpanId,
  generateTraceId,
  generateULID,
  writeEvent,
} from "./utils";
import { DomainError, sanitizeBoundaryText } from "./turn-contract";

export function fixtureProfile(workspace: string): AcpExecutionProfile {
  const home = Deno.env.get("HOME");
  const environment: Record<string, string> = {};
  if (home !== undefined) {
    environment.HOME = home;
  }
  return {
    slug: "fixture",
    command: Deno.execPath(),
    args: [
      "run",
      "--cached-only",
      "--node-modules-dir=manual",
      `--config=${fileURLToPath(new URL("../deno.json", import.meta.url))}`,
      "--allow-env=ACP_FIXTURE_MODE,ACP_FIXTURE_ALLOWED,ACP_FIXTURE_AUTH_STATUS,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK",
      fileURLToPath(
        new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
      ),
    ],
    environment,
    workspace,
    transport: "local_stdio",
    accessRoute: "local_sidecar",
    costBasis: "local_free",
  };
}

export const CODEX_ACP_VERSION = "1.1.10";
const CODEX_CHATGPT_PROMPT_TIMEOUT_MS = 30 * 60_000;
const MAX_ADAPTER_PACKAGE_METADATA_BYTES = 65_536;

async function readBoundedTextFile(path: string, maxBytes: number) {
  const file = await Deno.open(path, { read: true });
  try {
    const bytes = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null) break;
      offset += read;
    }
    if (offset > maxBytes) throw new Error("file exceeds limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    file.close();
  }
}

async function operatorAuthorizedExecutable(pathValue: string | undefined) {
  if (
    pathValue === undefined || !pathValue.startsWith("/") ||
    pathValue.includes(",") || pathValue.includes(":")
  ) {
    throw new DomainError(
      "Codex ACP requires an absolute, delimiter-safe DYFJ_NODE_PATH",
    );
  }
  try {
    // DYFJ_NODE_PATH is operator-granted executable authority, not an
    // attestation of the selected binary's identity. Server profiles retain
    // read access; the standalone login task grants this selected path.
    const info = await Deno.stat(pathValue);
    if (
      info.isFile &&
      (Deno.build.os === "windows" || ((info.mode ?? 0) & 0o111) !== 0)
    ) {
      const canonical = await Deno.realPath(pathValue);
      if (canonical.includes(",") || canonical.includes(":")) {
        throw new Error("canonical path contains an unsupported delimiter");
      }
      return pathValue;
    }
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP executable is unavailable");
}

async function operatorAuthorizedToolchainDirectory(
  pathValue: string | undefined,
): Promise<string | undefined> {
  if (pathValue === undefined || pathValue === "") return undefined;
  if (
    !pathValue.startsWith("/") || pathValue.includes(",") ||
    pathValue.includes(":")
  ) {
    throw new DomainError(
      "Codex ACP requires an absolute, delimiter-safe toolchain directory",
    );
  }
  if (/^\/+$/u.test(pathValue)) {
    throw new DomainError("Codex ACP toolchain directory is unavailable");
  }
  try {
    const noFollowPath = pathValue.replace(/\/+$/, "");
    const info = await Deno.lstat(noFollowPath);
    if (info.isDirectory && !info.isSymlink) {
      const canonical = await Deno.realPath(noFollowPath);
      if (canonical.includes(",") || canonical.includes(":")) {
        throw new Error("canonical path contains an unsupported delimiter");
      }
      const canonicalInfo = await Deno.lstat(canonical);
      if (
        !canonicalInfo.isDirectory || canonicalInfo.isSymlink ||
        (Deno.build.os !== "windows" &&
          (canonicalInfo.uid !== Deno.uid() ||
            ((canonicalInfo.mode ?? 0) & 0o100) === 0 ||
            ((canonicalInfo.mode ?? 0) & 0o022) !== 0)) ||
        (info.dev !== null && info.ino !== null &&
          canonicalInfo.dev !== null && canonicalInfo.ino !== null &&
          (canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino))
      ) {
        throw new Error("canonical directory authority changed");
      }
      return canonical;
    }
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP toolchain directory is unavailable");
}

async function operatorAuthorizedRustupHomeDirectory(
  pathValue: string | undefined,
): Promise<string | undefined> {
  if (pathValue === undefined || pathValue === "") return undefined;
  if (
    !pathValue.startsWith("/") || pathValue.includes(",") ||
    pathValue.includes(":")
  ) {
    throw new DomainError(
      "Codex ACP requires an absolute, delimiter-safe Rustup home directory",
    );
  }
  if (/^\/+$/u.test(pathValue)) {
    throw new DomainError("Codex ACP Rustup home directory is unavailable");
  }
  try {
    const noFollowPath = pathValue.replace(/\/+$/, "");
    const info = await Deno.lstat(noFollowPath);
    if (info.isDirectory && !info.isSymlink) {
      const canonical = await Deno.realPath(noFollowPath);
      if (canonical.includes(",") || canonical.includes(":")) {
        throw new Error("canonical path contains an unsupported delimiter");
      }
      const canonicalInfo = await Deno.lstat(canonical);
      if (
        !canonicalInfo.isDirectory || canonicalInfo.isSymlink ||
        (Deno.build.os !== "windows" &&
          (canonicalInfo.uid !== Deno.uid() ||
            ((canonicalInfo.mode ?? 0) & 0o700) !== 0o700 ||
            ((canonicalInfo.mode ?? 0) & 0o022) !== 0)) ||
        (info.dev !== null && info.ino !== null &&
          canonicalInfo.dev !== null && canonicalInfo.ino !== null &&
          (canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino))
      ) {
        throw new Error("canonical directory authority changed");
      }
      return canonical;
    }
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP Rustup home directory is unavailable");
}

async function ensurePrivateDirectory(
  path: string,
  enforceExistingMode = true,
): Promise<void> {
  let created = false;
  try {
    await Deno.mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new DomainError("Codex ACP runner home is unavailable");
  }
  if (
    !created && Deno.build.os !== "windows" &&
    (info.uid !== Deno.uid() ||
      ((info.mode ?? 0) & 0o022) !== 0)
  ) {
    throw new DomainError("Codex ACP runner home is unavailable");
  }
  if (created || enforceExistingMode) await Deno.chmod(path, 0o700);
}

async function requireOwnedDirectory(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (
      info.isDirectory && !info.isSymlink &&
      (Deno.build.os === "windows" ||
        (info.uid === Deno.uid() && ((info.mode ?? 0) & 0o022) === 0))
    ) return;
  } catch {
    // Use the fixed diagnostic below instead of disclosing the supplied path.
  }
  throw new DomainError("Codex ACP operator home is unavailable");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writePrivateNodeShim(
  directory: string,
  nodePath: string,
): Promise<void> {
  let temporary: string | undefined;
  try {
    temporary = await Deno.makeTempFile({
      dir: directory,
      prefix: ".node-",
    });
    await Deno.writeTextFile(
      temporary,
      `#!/bin/sh\nexec ${shellSingleQuote(nodePath)} "$@"\n`,
    );
    await Deno.chmod(temporary, 0o700);
    await Deno.rename(temporary, join(directory, "node"));
  } catch {
    if (temporary !== undefined) {
      try {
        await Deno.remove(temporary);
      } catch {
        // The rename may already have consumed the temporary path.
      }
    }
    throw new DomainError("Codex ACP private Node shim is unavailable");
  }
}

async function writePrivateShellProfile(
  isolatedHome: string,
  fileName: ".bash_profile" | ".zprofile",
  childPath: string,
): Promise<void> {
  let temporary: string | undefined;
  try {
    temporary = await Deno.makeTempFile({
      dir: isolatedHome,
      prefix: `${fileName}-`,
    });
    await Deno.writeTextFile(
      temporary,
      `export PATH=${shellSingleQuote(childPath)}\n`,
    );
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, join(isolatedHome, fileName));
  } catch {
    if (temporary !== undefined) {
      try {
        await Deno.remove(temporary);
      } catch {
        // The rename may already have consumed the temporary path.
      }
    }
    throw new DomainError("Codex ACP private shell profile is unavailable");
  }
}

export interface CodexChatGptProfileOptions {
  home?: string;
  prototypeRoot?: string;
  nodePath?: string;
  toolchainPath?: string;
  rustupHome?: string;
}

export async function bundledCodexExecutable(
  packageRoot: string,
): Promise<string> {
  const resolvedPackageRoot = await Deno.realPath(packageRoot);
  const candidates = [
    join(
      resolvedPackageRoot,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    ),
    join(
      dirname(dirname(resolvedPackageRoot)),
      "@openai",
      "codex",
      "bin",
      "codex.js",
    ),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = await Deno.realPath(candidate);
      const info = await Deno.stat(resolved);
      if (
        info.isFile &&
        (Deno.build.os === "windows" || ((info.mode ?? 0) & 0o111) !== 0)
      ) return resolved;
    } catch {
      // The exact package may be nested or hoisted; check both layouts.
    }
  }
  throw new DomainError("Pinned Codex executable is unavailable");
}

export async function codexChatGptProfile(
  workspace: string,
  options: CodexChatGptProfileOptions = {},
): Promise<AcpExecutionProfile> {
  const operatorHome = options.home ?? Deno.env.get("HOME");
  if (
    operatorHome === undefined || !operatorHome.startsWith("/") ||
    operatorHome.includes(",") || operatorHome.includes(":")
  ) {
    throw new DomainError(
      "Codex ACP requires an absolute, delimiter-safe operator home",
    );
  }
  await requireOwnedDirectory(operatorHome);
  const dyfjRoot = join(operatorHome, ".dyfj");
  const runnerHomes = join(dyfjRoot, "runner-homes");
  const runnerRoot = join(runnerHomes, "codex-chatgpt");
  const runnerBin = join(runnerRoot, "bin");
  const isolatedHome = join(runnerRoot, "home");
  const codexHome = join(isolatedHome, ".codex");
  const cargoHome = join(isolatedHome, ".cargo");

  const prototypeRoot = options.prototypeRoot ??
    fileURLToPath(new URL("..", import.meta.url));
  const packageRoot = join(
    prototypeRoot,
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
  );
  let packageVersion: unknown;
  try {
    packageVersion = JSON.parse(
      await readBoundedTextFile(
        join(packageRoot, "package.json"),
        MAX_ADAPTER_PACKAGE_METADATA_BYTES,
      ),
    ).version;
  } catch {
    throw new DomainError("Pinned Codex ACP package is unavailable");
  }
  if (packageVersion !== CODEX_ACP_VERSION) {
    throw new DomainError("Pinned Codex ACP package version does not match");
  }
  const adapterEntry = await Deno.realPath(
    join(packageRoot, "dist", "index.js"),
  );
  const nodePath = await operatorAuthorizedExecutable(
    options.nodePath ?? Deno.env.get("DYFJ_NODE_PATH"),
  );
  const codexPath = await bundledCodexExecutable(packageRoot);
  const toolchainPath = await operatorAuthorizedToolchainDirectory(
    options.toolchainPath ?? Deno.env.get("DYFJ_CODEX_TOOLCHAIN_PATH"),
  );
  const rustupHome = await operatorAuthorizedRustupHomeDirectory(
    options.rustupHome ?? Deno.env.get("DYFJ_CODEX_RUSTUP_HOME"),
  );
  const projectedDirectories = new Set<string>();
  if (toolchainPath !== undefined) projectedDirectories.add(toolchainPath);
  if (rustupHome !== undefined) projectedDirectories.add(rustupHome);
  const toolchainDirectoryCount = projectedDirectories.size as 0 | 1 | 2;

  await ensurePrivateDirectory(dyfjRoot, false);
  await ensurePrivateDirectory(runnerHomes, false);
  await ensurePrivateDirectory(runnerRoot);
  await ensurePrivateDirectory(runnerBin);
  await ensurePrivateDirectory(isolatedHome);
  await ensurePrivateDirectory(codexHome);
  await ensurePrivateDirectory(cargoHome);
  await writePrivateNodeShim(runnerBin, nodePath);

  const childPath = [
    runnerBin,
    ...(toolchainPath === undefined ? [] : [toolchainPath]),
    "/usr/bin",
    "/bin",
  ].join(":");
  await writePrivateShellProfile(isolatedHome, ".zprofile", childPath);
  await writePrivateShellProfile(isolatedHome, ".bash_profile", childPath);
  const environment: Record<string, string> = {
    HOME: isolatedHome,
    CODEX_HOME: codexHome,
    CODEX_PATH: codexPath,
    CARGO_HOME: cargoHome,
    NO_BROWSER: "1",
    INITIAL_AGENT_MODE: "read-only",
    PATH: childPath,
  };
  if (rustupHome !== undefined) environment.RUSTUP_HOME = rustupHome;
  const user = Deno.env.get("USER");
  if (user !== undefined) environment.USER = user;
  return {
    slug: "codex-chatgpt",
    command: nodePath,
    args: [adapterEntry],
    environment,
    workspace,
    transport: "local_stdio",
    accessRoute: "subscription_oauth",
    costBasis: "subscription_quota",
    requiredAuthentication: "chat-gpt",
    promptTimeoutMs: CODEX_CHATGPT_PROMPT_TIMEOUT_MS,
    sessionUpdatePolicy: "long_running",
    protocolMessagePolicy: "long_running",
    toolchainDirectoryCount,
  };
}

async function resolveWorkspace(
  input: WorkbenchRuntimeInput,
  authContext: WorkbenchAuthContext,
): Promise<string> {
  let requested = input.workspaceRoot;
  if (input.sessionId !== undefined) {
    const stored = await fetchWorkbenchSessionWorkspaceRecord({
      sessionId: input.sessionId,
    });
    if (!stored.exists) {
      throw new DomainError("Workbench session not found");
    }
    if (stored.workspace === null) {
      throw new DomainError("Workbench session has no persisted workspace");
    }
    requested = stored.workspace;
  }
  const selected = workspaceRootForTransport(
    requested,
    authContext.transport,
  ) ?? input.rootOverride ?? Deno.cwd();
  try {
    const resolved = await Deno.realPath(selected);
    if ((await Deno.stat(resolved)).isDirectory) return resolved;
  } catch {
    // The fixed error below must not disclose the selected host path.
  }
  throw new DomainError("External-agent workspace is not a directory");
}

function receiptText(input: {
  sessionId: string;
  traceId: string;
  profile: AcpExecutionProfile;
  workspaceEvidence: string;
  result: Awaited<ReturnType<typeof runAcpAgent>>;
  routeEvidence?: AcpRouteEvidence;
  sessionProjectionSkipped?: boolean;
}): string {
  const route = verifiedRouteFacts(input.profile, input.routeEvidence);
  return [
    "External-agent turn receipt",
    `Session: ${input.sessionId}`,
    `Trace: ${input.traceId}`,
    `Runner: ${input.profile.slug} over ACP ${
      input.result.protocolVersion === undefined
        ? "(not negotiated)"
        : `v${input.result.protocolVersion}`
    }`,
    `ACP stop reason: ${input.result.acpStopReason ?? "not reported"}`,
    `External session: ${input.result.externalSessionId ?? "not created"}`,
    `Workspace: ${input.workspaceEvidence}`,
    `Transport: ${input.profile.transport}`,
    `Access route: ${route.accessRoute ?? "unverified"}`,
    `Route evidence: ${input.routeEvidence?.source ?? "unavailable"}`,
    ...(input.routeEvidence?.authenticationType === undefined ? [] : [
      `Agent authentication: ${input.routeEvidence.authenticationType}`,
    ]),
    `Cost basis: ${route.costBasis}`,
    `Toolchain directories: ${input.profile.toolchainDirectoryCount ?? 0}`,
    `Outcome: ${input.result.stopReason}`,
    `Elapsed: ${input.result.elapsedMs} ms`,
    ...(input.sessionProjectionSkipped
      ? ["Session projection: update skipped"]
      : []),
    "Evidence: Workbench observed the ACP exchange; the agent's inner state is opaque.",
  ].join("\n");
}

export function verifiedRouteFacts(
  profile: AcpExecutionProfile,
  evidence: AcpRouteEvidence | undefined,
): {
  accessRoute?: AcpExecutionProfile["accessRoute"];
  costBasis: AcpExecutionProfile["costBasis"];
} {
  if (
    evidence?.source !== "profile_declared" ||
    (profile.requiredAuthentication !== undefined &&
      evidence.authenticationType !== profile.requiredAuthentication)
  ) {
    return { costBasis: "unknown" };
  }
  return { accessRoute: profile.accessRoute, costBasis: profile.costBasis };
}

async function emitRuntimeEvent(
  handler: WorkbenchRuntimeInput["onRuntimeEvent"],
  event: WorkbenchRuntimeEvent,
): Promise<void> {
  if (handler === undefined) return;
  try {
    await handler(event);
  } catch {
    console.warn("Runtime event delivery skipped");
  }
}

export async function runExternalAgentWorkbenchRuntime(
  input: WorkbenchRuntimeInput & {
    runner: {
      kind: "acp";
      profile: "fixture" | "codex-chatgpt";
    };
  },
  dependencies: {
    resolveProfile?: (
      profile: "fixture" | "codex-chatgpt",
      workspace: string,
    ) => AcpExecutionProfile | Promise<AcpExecutionProfile>;
    runAgent?: typeof runAcpAgent;
  } = {},
): Promise<ExternalAgentWorkbenchRuntimeResult> {
  let cancellationClosed = false;
  const closeCancellation = () => {
    if (cancellationClosed) return;
    cancellationClosed = true;
    try {
      input.onCancellationClosed?.();
    } catch {
      // Cancellation registration cleanup is non-authoritative.
    }
  };
  const authContext = input.authContext ?? {
    transport: "loopback",
    authnStatus: "authenticated",
    authnMechanism: "local_user",
    authnIssuerRef: "local_os",
    authzBasis: "user_consent",
  } satisfies WorkbenchAuthContext;
  let workspace: string;
  let profile: AcpExecutionProfile;
  try {
    if (authContext.transport !== "loopback") {
      throw new DomainError(
        "External local agents are unavailable to remote callers",
      );
    }
    if (
      input.runner.profile === "codex-chatgpt" &&
      input.trustWorkspaceInstructions !== true
    ) {
      throw new DomainError(
        "codex-chatgpt requires explicit workspace trust",
      );
    }
    assertAcpPromptWithinLimit(input.prompt);
    workspace = await resolveWorkspace(input, authContext);
    profile = dependencies.resolveProfile === undefined
      ? input.runner.profile === "fixture"
        ? fixtureProfile(workspace)
        : await codexChatGptProfile(workspace)
      : await dependencies.resolveProfile(input.runner.profile, workspace);
  } catch (error) {
    closeCancellation();
    throw error;
  }

  const sessionId = input.sessionId ?? generateULID();
  const traceId = generateTraceId();
  const rootSpanId = generateSpanId();
  const principalId = input.principalId ?? "user";
  const workspaceEvidence = sanitizeBoundaryText(workspace, 1_024);
  const startedAt = Date.now();
  const authnFields = {
    authn_status: authContext.authnStatus,
    authn_mechanism: authContext.authnMechanism,
    authn_issuer_ref: authContext.authnIssuerRef,
  };
  let sessionStartWritten = false;
  let sessionCreated = false;
  let verifiedRouteEvidence: AcpRouteEvidence | undefined;
  const writePermissionVerdict = async (
    verdict: AcpPermissionVerdict,
    signal: AbortSignal,
  ) => {
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "agent_permission",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: verdict.source === "operator"
        ? principalId
        : "dyfj-workbench",
      principal_type: verdict.source === "operator" ? "human" : "service",
      action: verdict.source === "operator" ? "decide" : "enforce",
      resource: verdict.toolCallId,
      authz_basis: authContext.authzBasis,
      ...authnFields,
      permission_verdict: verdict.decision === "approve"
        ? "approved"
        : verdict.decision === "deny"
        ? "denied"
        : "cancelled",
      runner_kind: "external_agent",
      runner_profile: profile.slug,
      runner_protocol: "acp",
    }, { signal });
  };

  try {
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "sessionStart",
      sessionId,
      traceId,
      mode: input.mode,
    });
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "inputReceived",
      sessionId,
      promptLength: input.prompt.length,
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_start",
      trace_id: traceId,
      span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "human",
      action: "start",
      resource: "workbench_session",
      authz_basis: authContext.authzBasis,
      ...authnFields,
      content: input.prompt,
    });
    sessionStartWritten = true;
    if (input.sessionId === undefined) {
      await createWorkbenchSession({
        sessionId,
        slug: buildWorkbenchSessionSlug(sessionId),
        taskDescription: input.prompt,
        content: buildWorkbenchSessionContent({
          mode: input.mode,
          prompt: input.prompt,
          traceId,
          contextSources: [],
        }),
        workspace,
      });
      sessionCreated = true;
    }

    const result = await (dependencies.runAgent ?? runAcpAgent)({
      profile,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      onTextDelta: input.onTextDelta,
      confirmPermission: input.confirmExternalAgentPermission,
      onPermissionVerdict: writePermissionVerdict,
      onRouteVerified: async (evidence, signal) => {
        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "runner_selected",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: rootSpanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "select",
          resource: profile.slug,
          authz_basis: authContext.authzBasis,
          ...authnFields,
          runner_kind: "external_agent",
          runner_profile: profile.slug,
          runner_protocol: "acp",
          runner_transport: profile.transport,
          runner_access_route: profile.accessRoute,
          runner_cost_basis: profile.costBasis,
          runner_workspace: workspaceEvidence,
          runner_evidence_scope: "outer_only",
          runner_auth_type: evidence.authenticationType ?? null,
          runner_route_source: evidence.source,
        }, { signal });
        verifiedRouteEvidence = evidence;
      },
    });
    closeCancellation();
    const route = verifiedRouteFacts(profile, verifiedRouteEvidence);
    let receipt = receiptText({
      sessionId,
      traceId,
      profile,
      workspaceEvidence,
      result,
      routeEvidence: verifiedRouteEvidence,
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "agent_response",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "agent",
      action: "respond",
      resource: profile.slug,
      authz_basis: authContext.authzBasis,
      ...authnFields,
      content: result.text,
      stop_reason: result.stopReason,
      duration_ms: result.elapsedMs,
      runner_kind: "external_agent",
      runner_profile: profile.slug,
      runner_protocol: "acp",
      runner_protocol_version: result.protocolVersion === undefined
        ? null
        : String(result.protocolVersion),
      runner_stop_reason: result.acpStopReason ?? null,
      runner_external_session_id: result.externalSessionId ?? null,
      runner_agent_name: result.agentName ?? null,
      runner_agent_version: result.agentVersion ?? null,
      runner_transport: profile.transport,
      runner_access_route: route.accessRoute ?? null,
      runner_cost_basis: route.costBasis,
      runner_workspace: workspaceEvidence,
      runner_capabilities: JSON.stringify(result.capabilities),
      runner_evidence_scope: "outer_only",
      runner_auth_type: verifiedRouteEvidence?.authenticationType ?? null,
      runner_route_source: verifiedRouteEvidence?.source ?? null,
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_end",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "human",
      action: "end",
      resource: "workbench_session",
      authz_basis: authContext.authzBasis,
      ...authnFields,
      duration_ms: Date.now() - startedAt,
    });
    try {
      await updateWorkbenchSession({
        sessionId,
        content: buildWorkbenchSessionContent({
          mode: input.mode,
          prompt: input.prompt,
          traceId,
          contextSources: [],
          receipt,
        }),
      });
    } catch {
      console.warn("Session projection update skipped");
      receipt = receiptText({
        sessionId,
        traceId,
        profile,
        workspaceEvidence,
        result,
        routeEvidence: verifiedRouteEvidence,
        sessionProjectionSkipped: true,
      });
    }
    await emitRuntimeEvent(
      input.onRuntimeEvent,
      result.stopReason === "aborted"
        ? {
          type: "turnAborted",
          sessionId,
          traceId,
          turnId: input.turnId,
        }
        : result.stopReason === "error"
        ? {
          type: "turnFailed",
          sessionId,
          traceId,
          errorMessage: "External agent declined the turn",
        }
        : {
          type: "turnCompleted",
          sessionId,
          traceId,
        },
    );
    return {
      sessionId,
      traceId,
      stopReason: result.stopReason,
      text: result.text,
      receipt,
      runner: {
        kind: "external_agent",
        profile: profile.slug,
        protocol: "acp",
        protocolVersion: result.protocolVersion,
        externalStopReason: result.acpStopReason,
        externalSessionId: result.externalSessionId,
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        capabilities: result.capabilities,
        workspace,
        transport: profile.transport,
        ...(route.accessRoute === undefined
          ? {}
          : { accessRoute: route.accessRoute }),
        costBasis: route.costBasis,
        evidence: {
          source: "acp",
          innerState: "opaque",
          toolchainDirectoryCount: profile.toolchainDirectoryCount ?? 0,
          ...(verifiedRouteEvidence === undefined ? {} : {
            routeSource: verifiedRouteEvidence.source,
            ...(verifiedRouteEvidence.authenticationType === undefined ? {} : {
              authenticationType: verifiedRouteEvidence.authenticationType,
            }),
          }),
        },
        elapsedMs: result.elapsedMs,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
    };
  } catch (error) {
    try {
      closeCancellation();
    } catch {
      // Preserve the turn failure while still attempting durable finalization.
    }
    if (sessionStartWritten) {
      try {
        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "error",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: rootSpanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "invoke",
          resource: profile.slug,
          authz_basis: authContext.authzBasis,
          ...authnFields,
          stop_reason: "error",
          duration_ms: Date.now() - startedAt,
          runner_kind: "external_agent",
          runner_profile: profile.slug,
          runner_protocol: "acp",
          ...(verifiedRouteEvidence === undefined ? {} : {
            runner_auth_type: verifiedRouteEvidence.authenticationType ?? null,
            runner_route_source: verifiedRouteEvidence.source,
          }),
        });
      } catch {
        // The originating failure remains authoritative.
      }
      try {
        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "session_end",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: rootSpanId,
          principal_id: principalId,
          principal_type: "human",
          action: "end",
          resource: "workbench_session",
          authz_basis: authContext.authzBasis,
          ...authnFields,
          duration_ms: Date.now() - startedAt,
        });
      } catch {
        // Continue to the client-visible failure notification.
      }
    }
    if (sessionCreated) {
      try {
        await updateWorkbenchSession({
          sessionId,
          content: buildWorkbenchSessionContent({
            mode: input.mode,
            prompt: input.prompt,
            traceId,
            contextSources: [],
            receipt: "External-agent turn failed",
          }),
        });
      } catch {
        console.warn("Failed session projection update skipped");
      }
    }
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "turnFailed",
      sessionId,
      traceId,
      errorMessage: "External agent turn failed",
    });
    if (error instanceof AcpSessionUpdateLimitError) {
      throw new DomainError("ACP agent exceeded the session-update limit");
    }
    if (error instanceof AcpProtocolMessageLimitError) {
      throw new DomainError("ACP agent exceeded the protocol-message limit");
    }
    throw error;
  }
}
