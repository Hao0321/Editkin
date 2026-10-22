import { mkdtemp, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, toNamespacedPath } from "node:path";
import { assertTimeRemapLocalPathV1 } from "./timeRemapCacheIdentityV1";

const STEM = ".editkin-curve-source-";
/** Windows mkdtemp needs its native drive namespace past MAX_PATH. Keep that
 * transport internal: journals, identity guards and callers retain the same
 * canonical parent/path form. No short-root fallback or changed volume. */
export async function createSourceClockTemporaryWorkV1(parent: string): Promise<string> {
  await assertTimeRemapLocalPathV1(parent);
  if (!(await lstat(parent)).isDirectory()) throw Error("SOURCE_CLOCK_TEMP_PARENT_NOT_DIRECTORY");
  const prefix = join(parent, STEM), nativePrefix = process.platform === "win32" ? toNamespacedPath(prefix) : prefix;
  const created = await mkdtemp(nativePrefix);
  const directory = nativePrefix !== prefix && created.startsWith(nativePrefix) ? prefix + created.slice(nativePrefix.length) : created;
  const sameParent = process.platform === "win32" ? dirname(directory).toLowerCase() === parent.toLowerCase() : dirname(directory) === parent;
  if (!isAbsolute(directory) || resolve(directory) !== directory || !sameParent
    || !basename(directory).startsWith(STEM) || basename(directory).length <= STEM.length) throw Error("SOURCE_CLOCK_TEMP_RETURNED_OUTSIDE_PARENT");
  return directory;
}
