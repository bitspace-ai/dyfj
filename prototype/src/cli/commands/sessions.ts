/** `dyfj sessions`: list sessions grouped by project. */

import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";

interface SessionRow {
  slug?: string;
  sessionName?: string;
  updatedAt?: string;
}
interface ProjectGroup {
  project: string | null;
  sessions: SessionRow[];
}

export async function runSessions(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    try {
      const { projects } = await client.request("sessions/list") as {
        projects: ProjectGroup[];
      };
      for (const group of projects) {
        io.out(`\n${group.project ?? "(unfiled)"}\n`);
        for (const s of group.sessions) {
          const when = (s.updatedAt ?? "").slice(0, 16);
          io.out(
            `  ${(s.slug ?? "").padEnd(40)} ${when.padEnd(18)} ${
              s.sessionName ?? ""
            }\n`,
          );
        }
      }
      io.err(`resume one with: dyfj --session <session> (the first column)`);
    } finally {
      client.close();
    }
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
}
