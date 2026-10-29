import { mkdtemp } from "node:fs/promises";
import { basename, join, toNamespacedPath } from "node:path";

/** Keep the public cache path ordinary; only the Windows filesystem call is namespaced. */
export async function createMaterialCacheStagingDirectoryV1(parent: string, materialId: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(materialId)) throw new Error("invalid-material-staging-id");
  const prefix = join(parent, `.pending-${materialId}-`);
  // Node's Windows mkdtemp needs the extended-length prefix even when mkdir and
  // readFile already accept the same long path. On other platforms this is a no-op.
  const created = await mkdtemp(toNamespacedPath(prefix));
  return join(parent, basename(created));
}
