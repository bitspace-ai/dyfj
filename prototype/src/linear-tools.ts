import type {
  LinearIssueCreationBinding,
  McpHttpServerConfig,
} from "./config.ts";
import {
  type CommandDefinition,
  CommandExecutionError,
  type CommandInvocationResult,
  type CommandTraceContext,
  type JsonSchemaObject,
  type JsonSchemaProperty,
} from "./commands.ts";

const CREATE_ISSUE_TOOL = "create_issue";
export type LinearCreationUpstreamTool = "create_issue" | "save_issue";
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,30}(?![\s\S])/;
const TITLE_PATTERN =
  "^(?![\\s\\S]{201})(?=[\\s\\S])(?=[\\s\\S]*\\S)[\\s\\S]*(?![\\s\\S])";
const DESCRIPTION_PATTERN = "^(?![\\s\\S]{16001})[\\s\\S]*(?![\\s\\S])";
const RELATED_IDENTIFIER_PATTERN =
  "^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,30}(?![\\s\\S])";

const INVALID_ARGUMENTS =
  "Linear issue creation arguments failed bounded local validation.";
const INDETERMINATE_RESULT =
  "Linear issue creation is indeterminate; reconcile in Linear before retrying.";

export interface LinearIssueCreationReceipt {
  identifier: string;
}

export interface LinearIssueMcpResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type LinearIssueMcpCall = (input: {
  server: McpHttpServerConfig;
  token: string;
  tool: string;
  arguments: Record<string, unknown>;
  inputSchema: JsonSchemaObject;
  traceContext?: CommandTraceContext;
}) => Promise<LinearIssueMcpResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyOf(
  schema: JsonSchemaObject,
  name: string,
): JsonSchemaProperty | undefined {
  const properties = schema.properties;
  return properties !== undefined && Object.hasOwn(properties, name)
    ? properties[name]
    : undefined;
}

function enumAccepts(
  property: JsonSchemaProperty,
  values: readonly (string | number)[],
): boolean {
  return property.enum === undefined ||
    values.every((value) =>
      property.enum?.some((candidate) => Object.is(candidate, value))
    );
}

/**
 * The discovered connector schema must accept every field Workbench promises
 * to send. A mismatch withholds this tool instead of silently dropping data.
 */
export function supportsBoundedLinearCreateIssue(
  schema: JsonSchemaObject,
  binding: LinearIssueCreationBinding,
): boolean {
  const title = propertyOf(schema, "title");
  const description = propertyOf(schema, "description");
  const team = propertyOf(schema, "team");
  const project = propertyOf(schema, "project");
  const priority = propertyOf(schema, "priority");
  const relatedTo = propertyOf(schema, "relatedTo");
  if (
    title?.type !== "string" || description?.type !== "string" ||
    team?.type !== "string" || project?.type !== "string" ||
    (priority?.type !== "integer" && priority?.type !== "number") ||
    relatedTo?.type !== "array" || relatedTo.items?.type !== "string"
  ) {
    return false;
  }
  const supplied = new Set([
    "title",
    "description",
    "team",
    "project",
    "priority",
    "relatedTo",
  ]);
  const required = schema.required ?? [];
  if (
    required.includes("relatedTo") ||
    required.some((name) => !supplied.has(name))
  ) return false;
  return enumAccepts(team, [binding.teamId]) &&
    enumAccepts(project, Object.values(binding.projects)) &&
    enumAccepts(priority, [0, 1, 2, 3, 4]);
}

/** Project the creation subset without interpreting optional update-only schemas. */
export function projectLinearCreationUpstreamSchema(
  value: unknown,
  binding: LinearIssueCreationBinding,
): JsonSchemaObject | undefined {
  if (!isRecord(value) || value.type !== "object") return undefined;
  if (JSON.stringify(value).length > 64_000) return undefined;
  const rootKeys = new Set([
    "$schema",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "description",
    "title",
  ]);
  if (Object.keys(value).some((key) => !rootKeys.has(key))) return undefined;
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean"
  ) return undefined;
  if (!isRecord(value.properties)) return undefined;
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      !value.required.every((name) => typeof name === "string"))
  ) return undefined;
  const properties: Record<string, JsonSchemaProperty> = {};
  for (
    const name of [
      "title",
      "description",
      "team",
      "project",
      "priority",
      "relatedTo",
    ]
  ) {
    if (!Object.hasOwn(value.properties, name)) return undefined;
    const raw = value.properties[name];
    if (!isRecord(raw)) return undefined;
    const allowed = new Set([
      "type",
      "description",
      "title",
      ...(name === "relatedTo" ? ["items"] : ["enum"]),
    ]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) return undefined;
    let type = raw.type;
    if (
      Array.isArray(type) && type.length === 2 && type.includes("string") &&
      type.includes("null")
    ) type = "string";
    if (name === "relatedTo") {
      if (
        type !== "array" || !isRecord(raw.items) ||
        raw.items.type !== "string" || Object.keys(raw.items).some((key) =>
          !["type", "description", "title"].includes(key)
        )
      ) {
        return undefined;
      }
      properties[name] = { type: "array", items: { type: "string" } };
    } else {
      if (
        name === "priority"
          ? type !== "integer" && type !== "number"
          : type !== "string"
      ) return undefined;
      const property: JsonSchemaProperty = {
        type: type as "string" | "integer" | "number",
      };
      if (raw.enum !== undefined) {
        if (
          name === "title" || name === "description" ||
          !Array.isArray(raw.enum) || raw.enum.length > 32 ||
          !raw.enum.every((entry) =>
            entry === null || typeof entry === "string" ||
            typeof entry === "number" || typeof entry === "boolean"
          )
        ) return undefined;
        property.enum = raw.enum;
      }
      properties[name] = property;
    }
  }
  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    required: value.required as string[] | undefined,
    additionalProperties: false,
  };
  return supportsBoundedLinearCreateIssue(schema, binding) ? schema : undefined;
}

export function boundedLinearCreateIssueSchema(
  binding: LinearIssueCreationBinding,
): JsonSchemaObject {
  return {
    type: "object",
    required: ["title", "description", "project", "priority"],
    properties: {
      title: {
        type: "string",
        pattern: TITLE_PATTERN,
        description:
          "Issue title: 1-200 UTF-16 code units and not whitespace-only.",
      },
      description: {
        type: "string",
        pattern: DESCRIPTION_PATTERN,
        description: "Issue description: at most 16,000 UTF-16 code units.",
      },
      project: {
        type: "string",
        enum: Object.keys(binding.projects),
        description: "Exact configured project name.",
      },
      priority: {
        type: "integer",
        enum: [0, 1, 2, 3, 4],
        description: "Configured priority value from 0 through 4.",
      },
      relatedTo: {
        type: "array",
        items: { type: "string", pattern: RELATED_IDENTIFIER_PATTERN },
        description:
          "At most 10 distinct configured-connector issue identifiers.",
      },
    },
    additionalProperties: false,
  };
}

function validateAndMapArguments(
  value: Record<string, unknown>,
  binding: LinearIssueCreationBinding,
): Record<string, unknown> {
  const allowed = new Set([
    "title",
    "description",
    "project",
    "priority",
    "relatedTo",
  ]);
  if (Object.keys(value).some((name) => !allowed.has(name))) {
    throw new CommandExecutionError(INVALID_ARGUMENTS);
  }
  const { title, description, project, priority, relatedTo } = value;
  if (
    typeof title !== "string" || title.length < 1 || title.length > 200 ||
    title.trim().length === 0 || typeof description !== "string" ||
    description.length > 16_000 || typeof project !== "string" ||
    project.length < 1 || project.length > 200 ||
    !Object.hasOwn(binding.projects, project) ||
    typeof priority !== "number" || !Number.isInteger(priority) ||
    priority < 0 || priority > 4
  ) {
    throw new CommandExecutionError(INVALID_ARGUMENTS);
  }
  let boundedRelatedTo: string[] | undefined;
  if (relatedTo !== undefined) {
    if (
      !Array.isArray(relatedTo) || relatedTo.length > 10 ||
      !relatedTo.every((identifier) =>
        typeof identifier === "string" && identifier.length <= 64 &&
        LINEAR_IDENTIFIER.test(identifier)
      ) || new Set(relatedTo).size !== relatedTo.length
    ) {
      throw new CommandExecutionError(INVALID_ARGUMENTS);
    }
    boundedRelatedTo = [...relatedTo] as string[];
  }
  return {
    title,
    description,
    team: binding.teamId,
    project: binding.projects[project],
    priority,
    ...(boundedRelatedTo === undefined ? {} : { relatedTo: boundedRelatedTo }),
  };
}

function responseObject(result: LinearIssueMcpResult): Record<string, unknown> {
  let value: unknown;
  if (isRecord(result.structuredContent)) {
    value = result.structuredContent;
  } else {
    const textItems = (result.content ?? []).filter((item) =>
      item.type === "text" && typeof item.text === "string"
    );
    if (textItems.length !== 1) throw new Error("missing response object");
    value = JSON.parse(textItems[0].text as string);
  }
  if (!isRecord(value)) throw new Error("invalid response object");
  if (Object.hasOwn(value, "issue")) {
    const issue = value.issue;
    if (!isRecord(issue)) throw new Error("invalid issue object");
    return issue;
  }
  return value;
}

function associationIds(
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  objectKey: string,
): string[] {
  const ids: string[] = [];
  for (const key of [camelKey, snakeKey]) {
    if (Object.hasOwn(value, key) && typeof value[key] === "string") {
      ids.push(value[key] as string);
    }
  }
  if (Object.hasOwn(value, objectKey)) {
    const association = value[objectKey];
    // With explicit IDs, string associations are display labels.
    if (typeof association === "string" && ids.length === 0) {
      ids.push(association);
    }
    if (
      isRecord(association) && Object.hasOwn(association, "id") &&
      typeof association.id === "string"
    ) {
      ids.push(association.id);
    }
  }
  return ids;
}

export function projectLinearIssueCreationReceipt(
  result: LinearIssueMcpResult,
  expectedTeamId: string,
  expectedProjectId: string,
): LinearIssueCreationReceipt {
  if (result.isError === true) throw new Error("connector reported an error");
  const response = responseObject(result);
  const explicitIdentifier = Object.hasOwn(response, "identifier")
    ? response.identifier
    : undefined;
  const alias =
    Object.hasOwn(response, "id") && typeof response.id === "string" &&
      response.id.length <= 64 && LINEAR_IDENTIFIER.test(response.id)
      ? response.id
      : undefined;
  if (
    Object.hasOwn(response, "identifier") &&
    (typeof explicitIdentifier !== "string" ||
      (alias !== undefined && alias !== explicitIdentifier))
  ) throw new Error("conflicting identifier evidence");
  const identifier = explicitIdentifier ?? alias;
  const teamIds = associationIds(response, "teamId", "team_id", "team");
  const projectIds = associationIds(
    response,
    "projectId",
    "project_id",
    "project",
  );
  if (
    typeof identifier !== "string" || identifier.length > 64 ||
    !LINEAR_IDENTIFIER.test(identifier) || teamIds.length === 0 ||
    teamIds.some((id) => id !== expectedTeamId) || projectIds.length === 0 ||
    projectIds.some((id) => id !== expectedProjectId)
  ) {
    throw new Error("response evidence mismatch");
  }
  return { identifier };
}

function eventContent(
  server: McpHttpServerConfig,
  revision: string,
  result: CommandInvocationResult,
  upstreamTool: LinearCreationUpstreamTool,
): string {
  const identifier = !result.isError && typeof result.result === "string" &&
      LINEAR_IDENTIFIER.test(result.result)
    ? result.result
    : undefined;
  return JSON.stringify({
    outcome: result.isError || identifier === undefined ? "error" : "created",
    externalMcp: {
      server: server.id,
      tool: upstreamTool,
      revision,
      ...(identifier === undefined ? {} : { identifier }),
    },
  });
}

export function buildBoundedLinearCreateIssueCommand(input: {
  server: McpHttpServerConfig;
  binding: LinearIssueCreationBinding;
  token: string;
  revision: string;
  upstreamSchema: JsonSchemaObject;
  upstreamTool?: LinearCreationUpstreamTool;
  call: LinearIssueMcpCall;
}): CommandDefinition<string> | undefined {
  if (!supportsBoundedLinearCreateIssue(input.upstreamSchema, input.binding)) {
    return undefined;
  }
  const upstreamTool = input.upstreamTool ?? CREATE_ISSUE_TOOL;
  return {
    id: `mcp.${input.server.id}.${CREATE_ISSUE_TOOL}`,
    title: "Create configured Linear issue",
    description:
      "Create one issue in the configured Linear team and an exact allowlisted project.",
    inputSchema: boundedLinearCreateIssueSchema(input.binding),
    permission: {
      effects: ["write.external", "emit.event"],
      defaultDecision: "ask",
      resources: [`mcp:${input.server.id}/${upstreamTool}`],
      network: "configured-external",
      filesystem: "none",
      cost: "none",
    },
    redactArguments: true,
    redactResult: true,
    minimumClearance: "loopback",
    spanKind: "client",
    eventContent: (_isError, result) =>
      eventContent(input.server, input.revision, result, upstreamTool),
    executor: async (commandCall, context) => {
      const mapped = validateAndMapArguments(
        commandCall.arguments,
        input.binding,
      );
      let result: LinearIssueMcpResult;
      try {
        result = await input.call({
          server: input.server,
          token: input.token,
          tool: upstreamTool,
          arguments: mapped,
          inputSchema: input.upstreamSchema,
          ...(context.traceId !== undefined && context.spanId !== undefined
            ? {
              traceContext: {
                traceId: context.traceId,
                spanId: context.spanId,
                traceFlags: context.traceFlags ?? 0,
                ...(context.traceState === undefined
                  ? {}
                  : { traceState: context.traceState }),
              },
            }
            : {}),
        });
      } catch {
        throw new CommandExecutionError(INDETERMINATE_RESULT);
      }
      try {
        return projectLinearIssueCreationReceipt(
          result,
          input.binding.teamId,
          mapped.project as string,
        ).identifier;
      } catch {
        throw new CommandExecutionError(INDETERMINATE_RESULT);
      }
    },
  };
}
