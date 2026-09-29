/** `dyfj models`: list the runtime's model catalog. */

import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";
import { LIVENESS_PROBE_TIMEOUT_MS } from "./status.ts";

export interface ModelRow {
  slug?: string;
  displayName?: string;
  provider?: string;
  tier?: number;
  /** Server-computed locality (on-machine loopback provider); absent on older servers. */
  local?: boolean;
  capabilities?: string[];
}

export async function fetchModelSlugs(
  config: CliConfig,
  connect: ConnectFn = connectUnixClient,
): Promise<{ slugs: string[]; models: ModelRow[] } | { error: string }> {
  try {
    const signal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS);
    const client = await connect(config.socket, undefined, signal);
    try {
      const { models } = await client.request(
        "models/list",
        undefined,
        signal,
      ) as {
        models: ModelRow[];
      };
      const slugs = models
        .map((m) => m.slug)
        .filter((slug): slug is string =>
          typeof slug === "string" && slug.length > 0
        );
      return { slugs, models };
    } finally {
      client.close();
    }
  } catch (error) {
    return { error: socketError(error, config) };
  }
}

export async function runModels(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  const listed = await fetchModelSlugs(config, connect);
  if ("error" in listed) {
    io.err(listed.error);
    return 1;
  }
  const { models } = listed;
  const slugWidth = models.reduce(
    (w, m) => Math.max(w, (m.slug ?? "").length),
    0,
  );
  for (const m of models) {
    // Server-computed flag; only an explicit false marks a row (older servers
    // omit the field, and absence must not smear "unpriced" over the list).
    const unroutable = (m as { routable?: boolean }).routable === false
      ? "  [unpriced — not routable]"
      : "";
    const modality = (m as { modality?: string }).modality;
    const modalityStr = modality ? `${modality.padEnd(19)} ` : "";
    io.out(
      `${(m.slug ?? "").padEnd(slugWidth)} t${m.tier ?? "?"}  ` +
        `${modalityStr}${(m.provider ?? "").padEnd(10)} ${
          m.displayName ?? ""
        }${unroutable}\n`,
    );
  }
  return 0;
}
