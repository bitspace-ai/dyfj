// A persisted session event as the runtime reads it back: the `events` row
// normalized to camelCase with typed nulls. It is the wire shape of
// `events/query` and `sessions/inspect`, and the input to the conversation
// projection (context/conversation.ts).

export interface WorkbenchSessionEvent {
  sessionId?: string;
  eventId: string;
  eventType: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: number | null;
  traceState: string | null;
  spanKind: string | null;
  parentIsRemote: boolean | null;
  principalId: string;
  modelId: string | null;
  provider: string | null;
  api: string | null;
  content: string | null;
  stopReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costTotal: string | null;
  durationMs: number | null;
  providerCallOrder: number | null;
  providerCallPurpose: string | null;
  providerErrorClass: string | null;
  unparsedToolCallCount: number | null;
  unparsedToolCallCountIsLowerBound: boolean | null;
  runnerKind: string | null;
  runnerProfile: string | null;
  runnerProtocol: string | null;
  runnerProtocolVersion: string | null;
  runnerStopReason: string | null;
  runnerExternalSessionId: string | null;
  runnerAgentName: string | null;
  runnerAgentVersion: string | null;
  runnerTransport: string | null;
  runnerAccessRoute: string | null;
  runnerCostBasis: string | null;
  runnerWorkspace: string | null;
  runnerCapabilities: string[] | null;
  runnerEvidenceScope: string | null;
  runnerRouteSource: string | null;
  runnerAuthType: string | null;
  permissionVerdict: string | null;
  // tool-call audit fields, so resume can replay tool turns.
  toolName: string | null;
  toolCallId: string | null;
  toolArguments: Record<string, unknown> | null;
  toolResult: string | null;
  toolIsError: boolean | null;
  /** Whether every persisted field needed to reconstruct this tool event was valid. */
  toolHistoryValid?: boolean | null;
  createdAt: string;
}
