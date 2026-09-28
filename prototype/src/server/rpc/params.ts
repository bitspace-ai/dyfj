// Parameter parsing shared by the RPC method modules: the loose record view
// of a request's params, and the two sanitizers every identifier and
// free-text field passes through before a handler uses it. Each rejection is
// an `invalidParams` RpcError whose message names the field.

import { stripAnsiEscapes } from "../../kernel/mod.ts";
import { RpcError, RpcErrorCode } from "../../transport/mod.ts";

export function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null
    ? params as Record<string, unknown>
    : {};
}

export function sanitizeRpcIdentifier(
  val: unknown,
  fieldName: string,
  options: { required?: boolean; maxLen?: number } = {},
): string | undefined {
  const maxLen = options.maxLen ?? 256;
  if (val === undefined || val === null) {
    if (options.required) {
      throw new RpcError(
        RpcErrorCode.invalidParams,
        `${fieldName} is required`,
      );
    }
    return undefined;
  }
  if (typeof val !== "string") {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be a string`,
    );
  }
  if (val.length === 0 || val.length > maxLen) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be between 1 and ${maxLen} characters`,
    );
  }
  if (val.trim().length === 0) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot be empty or whitespace-only`,
    );
  }
  if (/[\s\x00-\x1F\x7F-\x9F\x1B]/.test(val)) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot contain control characters or whitespace`,
    );
  }
  return val;
}

export function sanitizeRpcString(
  val: unknown,
  fieldName: string,
  options: { required?: boolean; maxLen?: number; singleLine?: boolean } = {},
): string | undefined {
  const maxLen = options.maxLen ?? 256;
  if (val === undefined || val === null) {
    if (options.required) {
      throw new RpcError(
        RpcErrorCode.invalidParams,
        `${fieldName} is required`,
      );
    }
    return undefined;
  }
  if (typeof val !== "string") {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} must be a string`,
    );
  }
  if (val.length > maxLen * 2) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} exceeds maximum length of ${maxLen} characters`,
    );
  }
  let s = stripAnsiEscapes(val);
  if (options.singleLine !== false) {
    s = s.replace(/[\r\n\t\x00-\x1F\x7F-\x9F]/g, " ").replace(/\s+/g, " ");
  } else {
    s = s.replace(/\r\n|\r/g, "\n").replace(
      /[\t\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g,
      " ",
    );
  }
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} cannot be empty or whitespace-only`,
    );
  }
  if (trimmed.length > maxLen) {
    throw new RpcError(
      RpcErrorCode.invalidParams,
      `${fieldName} exceeds maximum length of ${maxLen} characters`,
    );
  }
  return trimmed;
}
