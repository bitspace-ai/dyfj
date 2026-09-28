// The tool conformance kit (`specs/03-testing.md` section 5).
//
// The kit is parameterized over a catalog, not over fixtures: it registers one
// test per command the registry holds, so a tool is covered by registration
// alone. For every `CommandDefinition` it checks that:
//
// - its schema is valid, and invalid arguments are rejected before the
//   executor runs (and before any approver is asked);
// - its effect classification is declared and coherent with its envelope;
// - its policy verdict under `strict` and `operator` matches its effects;
// - its redaction is applied to the event payload;
// - exactly one `tool_call` event is written per invocation.
//
// The kit never runs a real executor: every invocation goes through a copy of
// the command whose executor is a recording stub. What the kit exercises is
// the definition and the shared invoke path (validation, policy, approval,
// redaction, the event builder), which is what a tool author controls by
// writing a definition.

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert";
import type { EventInsert } from "../../src/store/mod.ts";
import {
  type CommandCall,
  type CommandDefinition,
  type CommandEffect,
  CommandExecutionError,
  type CommandPolicyContext,
  type CommandRegistry,
  type ConfirmToolApproval,
  createCommandRegistry,
  evaluateCommandPolicy,
  invokeCommandWithEvent,
  type JsonSchemaObject,
  type JsonSchemaProperty,
  type PolicyDecision,
  REDACTED,
} from "../../src/tools/mod.ts";

/** Every declared effect. The type check below keeps it equal to the union. */
const KNOWN_EFFECTS = [
  "read.memory",
  "read.external",
  "read.filesystem",
  "write.filesystem",
  "write.external",
  "run.checks",
  "run.process",
  "call.model.local",
  "call.model.paid",
  "emit.event",
] as const satisfies readonly CommandEffect[];
type _EveryEffectKnown = Exclude<
  CommandEffect,
  typeof KNOWN_EFFECTS[number]
> extends never ? true : never;
const _everyEffectKnown: _EveryEffectKnown = true;

const EXEC_EFFECTS: ReadonlySet<CommandEffect> = new Set([
  "run.checks",
  "run.process",
]);
const PROPERTY_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

const STRICT: CommandPolicyContext = {
  permissionLevel: "strict",
  loopback: true,
};
const OPERATOR: CommandPolicyContext = {
  permissionLevel: "operator",
  loopback: true,
};

export interface ToolConformanceOptions {
  /** Names the suite in test output. */
  name: string;
  /** The catalog under test; every command it holds is checked. */
  catalog: CommandRegistry;
}

/** Register the kit's tests for every command in `catalog`. */
export function toolConformance(options: ToolConformanceOptions): void {
  const commands = options.catalog.list();
  Deno.test(`tool conformance: ${options.name}: the catalog is not empty`, () => {
    assert(commands.length > 0, "a catalog under test must hold a command");
  });
  for (const command of commands) {
    Deno.test(
      `tool conformance: ${options.name}: ${command.id}`,
      async (t) => {
        await t.step("its schema is valid", () => {
          assertEquals(schemaProblems(command), []);
        });
        await t.step(
          "invalid arguments are rejected before the executor runs",
          async () => {
            await assertInvalidArgumentsRejected(command);
          },
        );
        await t.step("its effect classification is declared", () => {
          assertEquals(envelopeProblems(command), []);
        });
        await t.step(
          "its policy verdict under strict and operator matches its effects",
          () => {
            assertPolicyMatchesEffects(command);
          },
        );
        await t.step(
          "its redaction is applied to the event payload",
          async () => {
            await assertRedactionApplied(command);
          },
        );
        await t.step(
          "exactly one tool_call event is written per invocation",
          async () => {
            await assertOneEventPerInvocation(command);
          },
        );
      },
    );
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

/** Structural problems with a command's identity and input schema. */
export function schemaProblems(command: CommandDefinition): string[] {
  const problems: string[] = [];
  if (!/^\S+$/.test(command.id)) problems.push("id must be non-empty");
  if (command.title.trim() === "") problems.push("title must be non-empty");
  if (command.description.trim() === "") {
    problems.push("description must be non-empty");
  }
  const schema = command.inputSchema;
  if (schema.type !== "object") {
    problems.push("inputSchema.type must be object");
  }
  problems.push(...objectProblems("inputSchema", schema));
  let roundTrip: unknown;
  try {
    roundTrip = JSON.parse(JSON.stringify(schema));
  } catch {
    roundTrip = undefined;
  }
  if (JSON.stringify(roundTrip) !== JSON.stringify(schema)) {
    problems.push("inputSchema must survive a JSON round trip");
  }
  return problems;
}

function objectProblems(
  where: string,
  schema: Pick<
    JsonSchemaObject,
    "properties" | "required" | "additionalProperties"
  >,
): string[] {
  const problems: string[] = [];
  const properties = schema.properties ?? {};
  if (typeof properties !== "object" || Array.isArray(properties)) {
    return [`${where}.properties must be an object`];
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    problems.push(`${where}.additionalProperties must be a boolean`);
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    problems.push(`${where}.required must be an array`);
  } else {
    if (new Set(required).size !== required.length) {
      problems.push(`${where}.required has duplicates`);
    }
    for (const name of required) {
      if (!Object.hasOwn(properties, name)) {
        problems.push(`${where}.required names undeclared ${name}`);
      }
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (name === "") problems.push(`${where} declares an empty property name`);
    problems.push(...propertyProblems(`${where}.${name}`, property));
  }
  return problems;
}

function propertyProblems(
  where: string,
  property: JsonSchemaProperty,
): string[] {
  const problems: string[] = [];
  if (!PROPERTY_TYPES.has(property.type)) {
    return [`${where}.type is not a supported type`];
  }
  if (
    property.description !== undefined &&
    typeof property.description !== "string"
  ) {
    problems.push(`${where}.description must be a string`);
  }
  if (property.redact !== undefined && typeof property.redact !== "boolean") {
    problems.push(`${where}.redact must be a boolean`);
  }
  if (property.pattern !== undefined) {
    if (property.type !== "string") {
      problems.push(`${where}.pattern applies only to strings`);
    }
    try {
      new RegExp(property.pattern);
    } catch {
      problems.push(`${where}.pattern does not compile`);
    }
  }
  if (property.enum !== undefined) {
    if (!Array.isArray(property.enum) || property.enum.length === 0) {
      problems.push(`${where}.enum must be a non-empty array`);
    } else if (!property.enum.every((value) => matchesType(property, value))) {
      problems.push(`${where}.enum holds a value of another type`);
    }
  }
  if (property.items !== undefined || property.maxItems !== undefined) {
    if (property.type !== "array") {
      problems.push(`${where}.items and maxItems apply only to arrays`);
    }
  }
  if (property.items !== undefined) {
    problems.push(...propertyProblems(`${where}.items`, property.items));
  }
  if (
    property.maxItems !== undefined &&
    !(Number.isInteger(property.maxItems) && property.maxItems >= 0)
  ) {
    problems.push(`${where}.maxItems must be a non-negative integer`);
  }
  if (
    property.properties !== undefined || property.required !== undefined ||
    property.additionalProperties !== undefined
  ) {
    if (property.type !== "object") {
      problems.push(`${where} declares object keywords on a non-object`);
    } else {
      problems.push(...objectProblems(where, property));
    }
  }
  return problems;
}

function matchesType(property: JsonSchemaProperty, value: unknown): boolean {
  switch (property.type) {
    case "integer":
      return Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null &&
        !Array.isArray(value);
    default:
      return typeof value === property.type;
  }
}

// ── Invocation harness ────────────────────────────────────────────────────────

interface Harness {
  events: EventInsert[];
  executorCalls: number;
  approverCalls: number;
  invoke(
    args: Record<string, unknown>,
    policy: CommandPolicyContext,
    verdict: "approve" | "deny",
  ): ReturnType<typeof invokeCommandWithEvent>;
}

/**
 * A registry holding a copy of `command` whose executor records its calls and
 * returns `result` (or throws `throws`). `acceptAnyArguments` swaps the input
 * schema for an open object, for the checks that must reach the executor
 * without knowing a tool's valid arguments.
 */
function harness(
  command: CommandDefinition,
  options: {
    result?: unknown;
    throws?: Error;
    acceptAnyArguments?: boolean;
  } = {},
): Harness {
  const state = {
    events: [] as EventInsert[],
    executorCalls: 0,
    approverCalls: 0,
  };
  const stub: CommandDefinition = {
    ...command,
    ...(options.acceptAnyArguments === true
      ? { inputSchema: { type: "object" } }
      : {}),
    executor: () => {
      state.executorCalls++;
      if (options.throws !== undefined) throw options.throws;
      return options.result ?? "kit-result";
    },
  };
  const registry = createCommandRegistry([stub]);
  let calls = 0;
  return {
    get events() {
      return state.events;
    },
    get executorCalls() {
      return state.executorCalls;
    },
    get approverCalls() {
      return state.approverCalls;
    },
    invoke(args, policy, verdict) {
      const approver: ConfirmToolApproval = () => {
        state.approverCalls++;
        return Promise.resolve({ decision: verdict });
      };
      calls++;
      return invokeCommandWithEvent(
        registry,
        kitCall(command.id, args, `kit-call-${calls}`),
        {
          sessionId: "01KITSESSION00000000000000",
          traceId: "0123456789abcdef0123456789abcdef",
          writeEvent: (event) => {
            state.events.push(event);
          },
        },
        approver,
        policy,
      );
    },
  };
}

function kitCall(
  commandId: string,
  args: Record<string, unknown>,
  callId = "kit-call",
): CommandCall {
  return {
    commandId,
    callId,
    caller: { principalId: "kit-operator", principalType: "human" },
    arguments: args,
  };
}

// ── Invalid arguments ─────────────────────────────────────────────────────────

/** A sentinel no real payload contains, so the kit can find it in an event. */
function argumentSentinel(name: string): string {
  return `kit-argument-sentinel-${name}`;
}

/**
 * Every declared property set to a value of the wrong type: arguments the
 * validator must reject whatever else the schema says. A string property gets
 * an array holding its sentinel; every other type gets the sentinel string.
 */
function wrongTypedArguments(
  schema: JsonSchemaObject,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => [
      name,
      property.type === "string"
        ? [argumentSentinel(name)]
        : argumentSentinel(name),
    ]),
  );
}

/** The argument objects the schema itself says are invalid. */
export function invalidArgumentCases(
  schema: JsonSchemaObject,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const cases: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  if ((schema.required ?? []).length > 0) {
    cases.push({ name: "a required argument is missing", arguments: {} });
  }
  if (schema.additionalProperties === false) {
    cases.push({
      name: "an undeclared argument is present",
      arguments: { "kit-undeclared": argumentSentinel("kit-undeclared") },
    });
  }
  if (Object.keys(schema.properties ?? {}).length > 0) {
    cases.push({
      name: "every argument has the wrong type",
      arguments: wrongTypedArguments(schema),
    });
  }
  return cases;
}

async function assertInvalidArgumentsRejected(
  command: CommandDefinition,
): Promise<void> {
  // A schema with no properties, no required argument and no
  // additionalProperties: false admits every argument object, so no argument
  // object is invalid and this check holds vacuously. Only an external MCP
  // tool whose upstream schema is open can look like that; every builtin
  // declares its arguments.
  const cases = invalidArgumentCases(command.inputSchema);
  for (const invalid of cases) {
    // The most permissive context and an approving approver: only validation
    // may stop the call.
    const run = harness(command);
    const result = await run.invoke(invalid.arguments, OPERATOR, "approve");
    assertStrictEquals(result.decision, "deny", invalid.name);
    assertStrictEquals(
      result.authzBasis,
      "policy:deny:invalid-arguments",
      invalid.name,
    );
    assertStrictEquals(run.executorCalls, 0, invalid.name);
    assertStrictEquals(run.approverCalls, 0, invalid.name);
  }
}

// ── Effects and envelope ──────────────────────────────────────────────────────

/** Gaps and contradictions in a command's declared permission envelope. */
export function envelopeProblems(command: CommandDefinition): string[] {
  const problems: string[] = [];
  const { effects, filesystem, network, cost } = command.permission;
  const known = new Set<string>(KNOWN_EFFECTS);
  if (effects.length === 0) problems.push("effects must be declared");
  if (new Set(effects).size !== effects.length) {
    problems.push("effects has duplicates");
  }
  for (const effect of effects) {
    if (!known.has(effect)) problems.push(`unknown effect ${effect}`);
  }
  if (!effects.includes("emit.event")) {
    problems.push("every command emits its tool_call event (emit.event)");
  }
  if (command.permission.resources.length === 0) {
    problems.push("resources must be declared");
  }
  if (filesystem === undefined) problems.push("filesystem must be declared");
  if (network === undefined) problems.push("network must be declared");
  if (cost === undefined) problems.push("cost must be declared");
  if (effects.includes("write.filesystem") !== (filesystem === "write")) {
    problems.push("write.filesystem and filesystem: write go together");
  }
  if (effects.includes("read.filesystem") && filesystem === "none") {
    problems.push("read.filesystem needs filesystem read or write");
  }
  if (
    (effects.includes("read.external") || effects.includes("write.external")) &&
    network !== "external" && network !== "configured-external"
  ) {
    problems.push("an external effect needs an external network envelope");
  }
  if (effects.includes("call.model.paid") !== (cost === "paid")) {
    problems.push("call.model.paid and cost: paid go together");
  }
  return problems;
}

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * The verdict a command's effects entitle it to, under the strict and the
 * operator profile on a loopback turn. This is the kit's own statement of the
 * effect contract (README Section 1: permissions reason about call shape), not
 * a call into the policy, so a policy change or a mis-declared tool shows up
 * as a mismatch.
 */
export function expectedVerdicts(
  command: CommandDefinition,
): { strict: PolicyDecision; operator: PolicyDecision } {
  const both = (decision: PolicyDecision) => ({
    strict: decision,
    operator: decision,
  });
  const { effects, defaultDecision, filesystem, network, cost } =
    command.permission;
  if (defaultDecision !== "allow") return both(defaultDecision);
  // Process execution always asks, whatever else the envelope says.
  if (effects.some((effect) => EXEC_EFFECTS.has(effect))) return both("ask");
  // Spend and external writes are never auto-approved.
  if (cost !== "none") return both("ask");
  if (effects.includes("write.external")) return both("ask");
  // Egress to an endpoint the operator configured, read-only.
  if (network === "recall" || network === "configured-external") {
    return filesystem === "none" ? both("allow") : both("ask");
  }
  if (network === "external") return both("ask");
  // Local reads need no approval; a contained local write is approved per
  // call under strict and auto-approved under the operator profile.
  if (filesystem === "write") {
    return network === "none"
      ? { strict: "ask", operator: "allow" }
      : both("ask");
  }
  return both("allow");
}

function assertPolicyMatchesEffects(command: CommandDefinition): void {
  // Policy reasons about call shape: the verdict comes from the command and
  // its envelope, so an open schema and empty arguments isolate it from
  // validation (which the invalid-arguments step covers).
  const shape: CommandDefinition = {
    ...command,
    inputSchema: { type: "object" },
  };
  const call = kitCall(command.id, {});
  const expected = expectedVerdicts(command);
  assertEquals(
    {
      strict: evaluateCommandPolicy(shape, call, STRICT).decision,
      operator: evaluateCommandPolicy(shape, call, OPERATOR).decision,
    },
    expected,
  );
  // The operator profile never covers a turn that is not loopback.
  assertStrictEquals(
    evaluateCommandPolicy(shape, call, { ...OPERATOR, loopback: false })
      .decision,
    expected.strict,
  );
}

// ── Redaction ─────────────────────────────────────────────────────────────────

function parsedArguments(event: EventInsert): Record<string, unknown> {
  return JSON.parse(String(event.tool_arguments));
}

async function assertRedactionApplied(
  command: CommandDefinition,
): Promise<void> {
  const properties = command.inputSchema.properties ?? {};
  // Arguments, on a call that is denied as invalid: a denied call is still
  // logged, so its arguments pass the redactor too. Every declared property
  // carries a sentinel, plus one undeclared key.
  const args = {
    ...wrongTypedArguments(command.inputSchema),
    "kit-undeclared": argumentSentinel("kit-undeclared"),
  };
  const denied = harness(command);
  await denied.invoke(args, STRICT, "deny");
  assertStrictEquals(denied.events.length, 1);
  const logged = parsedArguments(denied.events[0]);
  const serialized = JSON.stringify(denied.events[0]);
  if (command.redactArguments === true) {
    // Whole-call redaction: declared keys become the sentinel, undeclared
    // keys are dropped.
    assertEquals(
      logged,
      Object.fromEntries(Object.keys(properties).map((key) => [key, REDACTED])),
    );
    for (const key of Object.keys(args)) {
      assertFalse(serialized.includes(argumentSentinel(key)), key);
    }
  } else {
    for (const [key, value] of Object.entries(args)) {
      if (properties[key]?.redact === true) {
        assertStrictEquals(logged[key], REDACTED, key);
        assertFalse(serialized.includes(argumentSentinel(key)), key);
      } else {
        assertEquals(logged[key], value, key);
      }
    }
  }

  // The result, on a call that runs.
  const resultSentinel = `kit-result-sentinel-${command.id}`;
  const allowed = harness(command, {
    result: resultSentinel,
    acceptAnyArguments: true,
  });
  const result = await allowed.invoke({}, OPERATOR, "approve");
  assertStrictEquals(allowed.events.length, 1);
  const event = allowed.events[0];
  if (expectedVerdicts(command).operator === "deny") {
    // A command that is always denied never produces a result to redact:
    // its event carries the policy's own deny reason.
    assertStrictEquals(result.isError, true);
    assertStrictEquals(allowed.executorCalls, 0);
    if (result.isError) assertStrictEquals(event.tool_result, result.reason);
    return;
  }
  assertStrictEquals(result.isError, false);
  if (command.redactResult === true) {
    assertStrictEquals(event.tool_result, REDACTED);
    assertFalse(JSON.stringify(event).includes(resultSentinel));
  } else {
    assertStrictEquals(event.tool_result, resultSentinel);
  }
  // The model still receives the unredacted result within the turn.
  if (!result.isError) assertStrictEquals(result.result, resultSentinel);
}

// ── Events ────────────────────────────────────────────────────────────────────

function assertToolCallEvent(
  command: CommandDefinition,
  events: EventInsert[],
  label: string,
): void {
  assertStrictEquals(events.length, 1, label);
  const [event] = events;
  assertStrictEquals(event.event_type, "tool_call", label);
  assertStrictEquals(event.tool_name, command.id, label);
  assertNotEquals(event.tool_call_id, undefined, label);
}

async function assertOneEventPerInvocation(
  command: CommandDefinition,
): Promise<void> {
  const [invalid] = invalidArgumentCases(command.inputSchema);
  if (invalid !== undefined) {
    const run = harness(command);
    await run.invoke(invalid.arguments, OPERATOR, "approve");
    assertToolCallEvent(command, run.events, "invalid arguments");
  }

  const approved = harness(command, { acceptAnyArguments: true });
  await approved.invoke({}, STRICT, "approve");
  assertToolCallEvent(command, approved.events, "allowed or approved");
  assertStrictEquals(
    approved.executorCalls,
    expectedVerdicts(command).strict === "deny" ? 0 : 1,
  );

  const refused = harness(command, { acceptAnyArguments: true });
  await refused.invoke({}, STRICT, "deny");
  assertToolCallEvent(command, refused.events, "refused by the approver");
  assertStrictEquals(
    refused.executorCalls,
    expectedVerdicts(command).strict === "allow" ? 1 : 0,
  );

  const failing = harness(command, {
    acceptAnyArguments: true,
    throws: new CommandExecutionError("kit executor failure"),
  });
  const failed = await failing.invoke({}, OPERATOR, "approve");
  assertStrictEquals(failed.isError, true);
  assertToolCallEvent(command, failing.events, "executor failed");
}
