// Idea and Work Packet record shapes shared by the domain model and its
// Markdown formatter.

export interface WorkbenchIdea {
  ideaId: string;
  sessionId: string;
  eventId: string | null;
  label: string;
  description: string;
  createdAt: string;
}

export interface WorkbenchWorkPacketSourceContext {
  sessionId: string;
  referencedEventId: string | null;
  excerpt: string;
  contextSources: string[];
}

export interface WorkbenchWorkPacketVerifierProvenance {
  verifierType: "human_operator" | "automated_test" | "model_eval";
  independenceNotes: string;
}

export interface WorkbenchWorkPacket {
  packetId: string;
  ideaId: string | null;
  sessionId: string;
  issueId: string | null;
  title: string;
  targetWorkspace: string | null;
  sourceContext: WorkbenchWorkPacketSourceContext;
  operatorIntent: string;
  proposedAcceptanceCriteria: string[];
  verifierProvenance: WorkbenchWorkPacketVerifierProvenance;
  createdAt: string;
}
