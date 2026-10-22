import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { canonicalJson } from "../shared/canonicalJson";
import type { TimeRemapFingerprintV1 } from "./timeRemapCacheContractV1";

export async function assertTimeRemapLocalPathV1(path: string) {
  assertLocalMediaPath(path);
  if (!isAbsolute(path) || resolve(path) !== path) throw Error("TIME_REMAP_CACHE_ABSOLUTE_NORMALIZED_PATH_REQUIRED");
  for (let p = path; ; p = dirname(p)) {
    const s = await lstat(p).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    if (s?.isSymbolicLink()) throw Error("TIME_REMAP_CACHE_REPARSE_REFUSED");
    if (p !== path && s && !s.isDirectory()) throw Error("TIME_REMAP_CACHE_ANCESTOR_NOT_DIRECTORY");
    if (dirname(p) === p) break;
  }
}
export async function timeRemapFingerprintV1(path: string): Promise<TimeRemapFingerprintV1> {
  await assertTimeRemapLocalPathV1(path); const s = await lstat(path, { bigint: true });
  if (!s.isFile() || s.size < 1n) throw Error("TIME_REMAP_CACHE_REGULAR_NONEMPTY_FILE_REQUIRED");
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
}
export async function timeRemapSha256V1(path: string, signal?: AbortSignal) {
  const before = await timeRemapFingerprintV1(path), h = createHash("sha256"), file = await open(path, "r"), buffer = Buffer.allocUnsafe(1024 ** 2);
  try {
    let at = 0;
    for (;;) { signal?.throwIfAborted(); const { bytesRead } = await file.read(buffer, 0, buffer.length, at); if (!bytesRead) break; h.update(buffer.subarray(0, bytesRead)); at += bytesRead; }
    if (String(at) !== before.size || canonicalJson(before) !== canonicalJson(await timeRemapFingerprintV1(path))) throw Error("TIME_REMAP_CACHE_FILE_CHANGED_DURING_HASH");
    return h.digest("hex");
  } finally { await file.close(); }
}
const identities = new Map<string, { fingerprint: string; sha256: string }>();
/** Tools may be memoized only while their complete local file identity is unchanged. */
export async function timeRemapToolIdentityV1(path: string, signal?: AbortSignal) {
  const fingerprint = canonicalJson(await timeRemapFingerprintV1(path)), prior = identities.get(path);
  if (prior?.fingerprint === fingerprint) return { path, sha256: prior.sha256 };
  const sha256 = await timeRemapSha256V1(path, signal); identities.set(path, { fingerprint, sha256 }); return { path, sha256 };
}
let implementation: Promise<{ sha256: string; stamps: Array<{ path: string; fingerprint: string }> }> | undefined;
/** Source-process identity. A loaded process refuses on-disk code changes instead of claiming to run new code. */
export async function timeRemapCacheImplementationV1() {
  if (!implementation) implementation = (async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), registry = resolve(root, "render/timeRemapCacheImplementationPathsV1.json");
    const names = JSON.parse(await readFile(registry, "utf8")) as string[];
    if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== "string"
      || (!["../../package.json", "../../package-lock.json"].includes(n) && (!/^\.\.\/[a-zA-Z0-9._/-]+\.(?:tsx?|json)$/.test(n) || n.includes("/../"))))) throw Error("TIME_REMAP_CACHE_IMPLEMENTATION_REGISTRY_INVALID");
    const rows = [], stamps = [];
    for (const name of [...new Set(names)].sort()) {
      const path = resolve(dirname(registry), name);
      rows.push({ name, sha256: await timeRemapSha256V1(path) }); stamps.push({ path, fingerprint: canonicalJson(await timeRemapFingerprintV1(path)) });
    }
    const registryFingerprint = canonicalJson(await timeRemapFingerprintV1(registry)); stamps.push({ path: registry, fingerprint: registryFingerprint });
    return { sha256: createHash("sha256").update(canonicalJson({ rows, node: process.versions.node, platform: process.platform, arch: process.arch })).digest("hex"), stamps };
  })();
  const value = await implementation;
  for (const s of value.stamps) if (canonicalJson(await timeRemapFingerprintV1(s.path)) !== s.fingerprint) throw Error("TIME_REMAP_CACHE_CODE_CHANGED_RESTART_REQUIRED");
  return value.sha256;
}
