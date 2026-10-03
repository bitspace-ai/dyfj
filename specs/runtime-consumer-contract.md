# Native runtime consumer contract

Status: exploratory contract with a runtime component test using fake
dependencies. This records the current seam and the decisions a second host
still needs; it does not declare a Workshop deployment or a new runtime package.

## Boundary already present

`runWorkbenchRuntime(input, services)` in
`prototype/src/engine/native-runner.ts` is an in-process turn entry. For a
native turn, it owns route resolution, session and event writes, context
assembly, budget gates, provider calls, tool policy and the final receipt. A
host supplies `WorkbenchRuntimeServices`: a `Store`, session budget owners,
workspace-root anchors, and optionally a clock, `Env`, provider HTTP transport
and context-overflow recoverer. The request plus in-process hooks form
`WorkbenchRuntimeInput`. The plain-data request is in `contract/runtime.ts`; the
approver, frame sink and cancellation window are engine ports, not JSON wire
fields. No CLI, REPL or Unix-socket server import is needed to call the engine.
The local Workbench server remains one composition root for those ports, and its
CLI and Rust REPL remain socket clients.

A host must bind the following explicitly for a trustworthy headless turn:

| Concern          | Existing input or port                                                   | Host obligation                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | `principalId`, `authContext`                                             | Identify the caller and set transport, authentication and authorization provenance. Omission currently defaults to a local-user identity, so a headless host must not omit these fields. Some event actor fields still use Workbench-specific identities. |
| Model and spend  | `routingOptions`, `defaultCompanionModel`, budget fields, `Approver`     | Select from the host's allowed model catalog; bind budgets and decide how paid or over-ceiling requests are denied or escalated. Missing approval handlers fail closed.                                                                                   |
| Workspace        | `rootOverride`, `workspaceRoot`, `RootAnchors`                           | Bind a root chosen by the host. A remote caller's `workspaceRoot` is ignored; it cannot change the host's root. The engine still has a cwd fallback if the host omits `rootOverride`, so a headless host must provide it.                                 |
| Context          | `Store.memories`, `Store.prompts`, `Env`, `trustWorkspaceInstructions`   | Supply only context this principal may receive. Existing memory visibility and `inject` rules apply; `trustWorkspaceInstructions` is an explicit authority decision. The engine does not yet accept a versioned task context packet.                      |
| Tools            | `permissionLevel`, `externalMcpCommands`, `Approver.confirmToolApproval` | Keep the policy at `strict` unless a stronger posture is deliberately authorized. The command policy validates call shape; an absent approver denies mutations that require approval. Supply only intended external commands.                             |
| State and output | `Store`, `FrameSink`, returned receipt                                   | Own store lifecycle and session admission, retain the receipt and events, and deliver frames without re-entering the running turn. The engine writes session and provider events through `journal.commit`.                                                |

`prototype/src/engine/headless-host.component.test.ts` calls the actual native
turn entry with two separately supplied stores and synthetic context records,
explicit host identity fields and roots, and a scripted provider transport. It
also requests a file mutation with no approval handler and checks for a denied
tool event and a specifically absent file. The test builder imports the runtime
through `engine/mod.ts` and composes `MemoryStore`, `SessionOwners`,
`CeilingConfirmationStore`, `RootAnchors`, `ManualClock`, `MapEnv` and
`ScriptedHttpTransport`. Its import chain stays in the engine and lower layers;
it does not import the CLI or `server/main.ts` bootstrap. When run, the test
exercises in-process execution and separately supplied context and state. It
does not establish per-principal authorization or filtering within a shared
store, real authentication, concurrent-host behavior, independent process
memory, workspace-root isolation, ambient-environment isolation, network
transport, Dolt persistence or Kubernetes behavior. Its authentication fields
and denial action are checked at the journal commit boundary; exposed session
and tool fields are checked through event read-back. The event reader omits the
authentication and action columns, so this test does not prove those fields
persisted. Fixture authentication fields do not verify a login.

## Next decisions, not current guarantees

- Define a task-scoped, versioned context packet and its source provenance,
  freshness, disclosure and size rules before giving scheduled agents private
  context. Today the memory store and transport clearance are the available
  mechanism; they do not express a per-bot need-to-know grant.
- Decide how a headless host authenticates a bot and maps it to an allowed
  model, tools, budget and store. The engine accepts these values; it does not
  authenticate the host or schedule jobs.
- Choose a deployment and process contract only when one actual Workshop
  workload consumes this runtime. That may be a packaged runtime in this repo
  with a Workshop-owned host. It need not make the local Workbench depend on a
  cluster, and it does not require a new repository.
- Settle the difference between the initiating principal and the executing agent
  before claiming complete event attribution for a headless bot.
  `model_selected` has a known principal exception, and agent-loop tool calls
  currently use the fixed caller ID `workbench`. The two completion cases in the
  component test contain no tool calls; their other events carry the supplied
  principal. A future fix should preserve this actor distinction explicitly
  rather than silently relabeling old event semantics.

This contract concerns the native model loop. External-agent (ACP) routes remain
deferred from the daily-use route plan under D29. It makes no decision about
fleet discovery, distributed session ownership or cross-host state.
