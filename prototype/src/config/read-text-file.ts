/**
 * The one adapter behind the `readTextFile` seams in this directory: read a
 * file as UTF-8 text. The config loaders and the nameserver reader take their
 * reader as an argument and default to this, so a test, or the launcher, can
 * inject another. A missing file rejects with an error whose `code` is
 * `ENOENT`; `readConfigFile` reads that as "no file".
 */

import { readFile } from "node:fs/promises";

export const readTextFile = (path: string): Promise<string> =>
  readFile(path, "utf8");
