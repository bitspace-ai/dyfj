export async function resolveEsbuildBinary(
  prototypeRoot: string,
): Promise<string> {
  const packageRoot =
    `${prototypeRoot}/node_modules/.deno/node_modules/@esbuild`;
  const candidates: string[] = [];
  for await (const platform of Deno.readDir(packageRoot)) {
    if (!platform.isDirectory && !platform.isSymlink) continue;
    const binRoot = `${packageRoot}/${platform.name}/bin`;
    try {
      for await (const entry of Deno.readDir(binRoot)) {
        if (
          entry.isFile &&
          (entry.name === "esbuild" || entry.name === "esbuild.exe")
        ) {
          candidates.push(
            `node_modules/.deno/node_modules/@esbuild/${platform.name}/bin/${entry.name}`,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `expected one installed esbuild binary, found ${candidates.length}`,
    );
  }
  return candidates[0];
}
