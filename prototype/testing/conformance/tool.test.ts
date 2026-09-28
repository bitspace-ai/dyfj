// Self-tests for the tool conformance kit: the kit over synthetic commands
// that cover every effect class (including envelopes no production tool has
// yet, such as a contained exec tool), and the kit's detectors against
// definitions that must fail them.

import { assertEquals } from "@std/assert";
import {
  buildToolCatalog,
  type CommandDefinition,
  type PermissionEnvelope,
} from "../../src/tools/mod.ts";
import {
  envelopeProblems,
  expectedVerdicts,
  invalidArgumentCases,
  schemaProblems,
  toolConformance,
} from "./tool.ts";

function synthetic(
  id: string,
  permission: Partial<PermissionEnvelope>,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    id,
    title: id,
    description: `Synthetic ${id} command.`,
    inputSchema: {
      type: "object",
      required: ["input"],
      properties: { input: { type: "string" } },
      additionalProperties: false,
    },
    permission: {
      effects: ["emit.event"],
      defaultDecision: "allow",
      resources: [`synthetic:${id}`],
      network: "none",
      filesystem: "none",
      cost: "none",
      ...permission,
    },
    executor: () => "synthetic",
    ...extra,
  };
}

const effectClasses = [
  synthetic("read.local", {
    effects: ["read.filesystem", "emit.event"],
    filesystem: "read",
  }),
  synthetic("write.contained", {
    effects: ["write.filesystem", "emit.event"],
    filesystem: "write",
  }),
  synthetic("exec.contained", {
    effects: ["run.checks", "write.filesystem", "emit.event"],
    filesystem: "write",
  }),
  synthetic("read.configured", {
    effects: ["read.external", "emit.event"],
    network: "configured-external",
  }),
  synthetic("read.external", {
    effects: ["read.external", "emit.event"],
    network: "external",
  }),
  synthetic("write.external", {
    effects: ["write.external", "emit.event"],
    network: "configured-external",
    defaultDecision: "ask",
  }),
  synthetic("recall", {
    effects: ["read.memory", "emit.event"],
    network: "recall",
  }),
  synthetic("paid", {
    effects: ["call.model.paid", "emit.event"],
    network: "external",
    cost: "paid",
  }),
  synthetic("denied", { defaultDecision: "deny" }),
  synthetic("redacted", {}, {
    inputSchema: {
      type: "object",
      required: ["secret"],
      properties: {
        secret: { type: "string", redact: true },
        label: { type: "string" },
      },
    },
    redactResult: true,
  }),
  synthetic("redacted.whole", {}, { redactArguments: true }),
];

toolConformance({
  name: "synthetic effect classes",
  catalog: buildToolCatalog({}, {}, effectClasses, []),
});

Deno.test("the kit's effect contract: one verdict pair per effect class", () => {
  assertEquals(
    Object.fromEntries(
      effectClasses.map((command) => [command.id, expectedVerdicts(command)]),
    ),
    {
      "read.local": { strict: "allow", operator: "allow" },
      "write.contained": { strict: "ask", operator: "allow" },
      "exec.contained": { strict: "ask", operator: "ask" },
      "read.configured": { strict: "allow", operator: "allow" },
      "read.external": { strict: "ask", operator: "ask" },
      "write.external": { strict: "ask", operator: "ask" },
      "recall": { strict: "allow", operator: "allow" },
      "paid": { strict: "ask", operator: "ask" },
      "denied": { strict: "deny", operator: "deny" },
      "redacted": { strict: "allow", operator: "allow" },
      "redacted.whole": { strict: "allow", operator: "allow" },
    },
  );
});

Deno.test("schemaProblems flags an invalid schema", () => {
  const command = synthetic("bad", {}, {
    title: " ",
    inputSchema: {
      type: "object",
      required: ["missing", "input"],
      properties: {
        input: { type: "string", pattern: "(" },
        count: { type: "number", pattern: "^1$", enum: ["one"] },
        list: { type: "array", maxItems: -1, items: { type: "string" } },
        flag: { type: "boolean", items: { type: "string" } },
      },
    },
  });
  assertEquals(schemaProblems(command), [
    "title must be non-empty",
    "inputSchema.required names undeclared missing",
    "inputSchema.input.pattern does not compile",
    "inputSchema.count.pattern applies only to strings",
    "inputSchema.count.enum holds a value of another type",
    "inputSchema.list.maxItems must be a non-negative integer",
    "inputSchema.flag.items and maxItems apply only to arrays",
  ]);
});

Deno.test("envelopeProblems flags an undeclared or contradictory envelope", () => {
  assertEquals(
    envelopeProblems(synthetic("gaps", {
      effects: [],
      resources: [],
      network: undefined,
      filesystem: undefined,
      cost: undefined,
    })),
    [
      "effects must be declared",
      "every command emits its tool_call event (emit.event)",
      "resources must be declared",
      "filesystem must be declared",
      "network must be declared",
      "cost must be declared",
    ],
  );
  assertEquals(
    envelopeProblems(synthetic("contradictions", {
      effects: [
        "write.filesystem",
        "read.external",
        "call.model.paid",
        "emit.event",
        "emit.event",
      ],
      filesystem: "read",
      network: "local",
      cost: "none",
    })),
    [
      "effects has duplicates",
      "write.filesystem and filesystem: write go together",
      "an external effect needs an external network envelope",
      "call.model.paid and cost: paid go together",
    ],
  );
});

Deno.test("invalidArgumentCases derives every invalid shape a schema declares", () => {
  assertEquals(
    invalidArgumentCases(synthetic("any", {}).inputSchema).map(({ name }) =>
      name
    ),
    [
      "a required argument is missing",
      "an undeclared argument is present",
      "every argument has the wrong type",
    ],
  );
  assertEquals(invalidArgumentCases({ type: "object" }), []);
});
