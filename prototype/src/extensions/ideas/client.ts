/**
 * The interactive REPL's entry into extensions/ideas/. The REPL's `/idea` and
 * `/packet` commands speak `ideas/*` and `packets/*` over the socket; when a
 * test runs the REPL without the socket (`unix: false`) they use these
 * in-process pieces instead, over a registry the REPL session owns.
 *
 * Allowed dependencies: this directory's own modules.
 */

export {
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  IdeaPacketRegistry,
  markWorkbenchIdea,
  stripOuterQuotes,
  type WorkbenchIdea,
  type WorkbenchWorkPacket,
} from "./idea-packet.ts";
