/**
 * The next-work worklet: the brief the model receives, the strict-JSON
 * validation of its answer, and the presenter lines for the result.
 */

import type { AskContextProfile } from "../context/mod.ts";

export interface NextWorkBriefInput {
  workletId: string;
  contextProfile: AskContextProfile;
  prompt: string;
}

export interface NextWorkResult {
  worklet_id: string;
  context_profile: AskContextProfile;
  recommendation: string;
  rationale: string;
  evidence: string[];
  risks: string[];
  next_commands: string[];
  confidence: "low" | "medium" | "high";
}

export type NextWorkValidationResult =
  | { ok: true; value: NextWorkResult; errors: [] }
  | { ok: false; value?: undefined; errors: string[] };

export function buildNextWorkBrief(input: NextWorkBriefInput): string {
  return [
    "Next-work worklet brief",
    `worklet_id: ${input.workletId}`,
    `context_profile: ${input.contextProfile}`,
    `operator_prompt: ${input.prompt}`,
    "",
    "Return strict JSON only. Do not wrap it in Markdown. Do not include prose before or after the JSON.",
    "Use only the supplied repo-local context. Do not infer from private operator, cockpit, or cross-repo strategy context.",
    "",
    "Required JSON shape:",
    "{",
    '  "worklet_id": "next-work.v0",',
    '  "context_profile": "compact",',
    '  "recommendation": "one concrete next work item",',
    '  "rationale": "why this is next from the supplied context",',
    '  "evidence": ["specific context source or evidence"],',
    '  "risks": ["what could make this recommendation wrong"],',
    '  "next_commands": ["small commands the operator can run"],',
    '  "confidence": "low|medium|high"',
    "}",
  ].join("\n");
}

export function validateNextWorkJson(text: string): NextWorkValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["model output was not strict JSON"] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ["model output JSON was not an object"] };
  }

  const errors: string[] = [];
  for (
    const field of [
      "worklet_id",
      "context_profile",
      "recommendation",
      "rationale",
      "evidence",
      "risks",
      "next_commands",
      "confidence",
    ]
  ) {
    if (!(field in parsed)) errors.push(`missing required field: ${field}`);
  }

  if (
    "context_profile" in parsed &&
    parsed.context_profile !== "compact" &&
    parsed.context_profile !== "full"
  ) {
    errors.push("context_profile must be compact or full");
  }
  for (const field of ["worklet_id", "recommendation", "rationale"] as const) {
    if (field in parsed && typeof parsed[field] !== "string") {
      errors.push(`${field} must be a string`);
    }
  }
  for (const field of ["evidence", "risks", "next_commands"] as const) {
    if (field in parsed && !isStringArray(parsed[field])) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  if (
    "confidence" in parsed &&
    parsed.confidence !== "low" &&
    parsed.confidence !== "medium" &&
    parsed.confidence !== "high"
  ) {
    errors.push("confidence must be low, medium, or high");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      worklet_id: parsed.worklet_id as string,
      context_profile: parsed.context_profile as AskContextProfile,
      recommendation: parsed.recommendation as string,
      rationale: parsed.rationale as string,
      evidence: parsed.evidence as string[],
      risks: parsed.risks as string[],
      next_commands: parsed.next_commands as string[],
      confidence: parsed.confidence as "low" | "medium" | "high",
    },
    errors: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

export function printNextWorkResult(
  result: NextWorkValidationResult,
  rawText: string,
  log: (...parts: unknown[]) => void,
): void {
  if (!result.ok) {
    log("Next-work validation failed");
    for (const error of result.errors) {
      log(`- ${error}`);
    }
    log("");
    log("Raw model output:");
    log(rawText);
    return;
  }

  log("Next work");
  log(`Recommendation: ${result.value.recommendation}`);
  log(`Rationale: ${result.value.rationale}`);
  log(`Confidence: ${result.value.confidence}`);
  if (result.value.evidence.length > 0) {
    log("Evidence:");
    for (const item of result.value.evidence) {
      log(`- ${item}`);
    }
  }
  if (result.value.risks.length > 0) {
    log("Risks:");
    for (const item of result.value.risks) {
      log(`- ${item}`);
    }
  }
  if (result.value.next_commands.length > 0) {
    log("Next commands:");
    for (const command of result.value.next_commands) {
      log(`- ${command}`);
    }
  }
}
