import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import { writeProceduralSfxPackV1 } from "../application/proceduralSfxPackV1";
import { createProceduralSfxLibraryV1, type ProceduralSfxLibraryV1 } from "../application/proceduralSfxLibraryV1";
import { materializeCreativeAssets, creativeAssetIdFromUri, type ResolvedCreativeAsset } from "../application/creativeLibrary";
import { proceduralSfxRecipeV1 } from "../application/proceduralSfxCatalogueV1";
import type { EditProject } from "../domain/types";
import { isOriginalSfxCandidateIdV1, assertOriginalSfxCandidateSummaryV1, type OriginalSfxCandidateAssetV1, type OriginalSfxCandidateSummaryV1 } from "../domain/originalSfxCandidateContractV1";

/** Source revision pins, not a public rights certificate. Tests bind these to the actual source files. */
export const ORIGINAL_SFX_GENERATOR_PINS_V1 = Object.freeze([
  Object.freeze({ path: "src/application/proceduralSfxCatalogueV1.ts", bytes: 2013, sha256: "0d6d21b00ce5fba618f0da70f78023f9d8f991f123269a346c7b1bab526df007" }),
  Object.freeze({ path: "src/application/proceduralSfxSynthV1.ts", bytes: 3418, sha256: "1c2d41dbe97558ca8386080882a71968293a4f88d99a0ab114479dd2baa76869" }),
]);
export interface OriginalSfxRuntimeV1 { personalMusicRoot?: string; creativePackRoot?: string; personalVisualRoot?: string }
const pending = new Map<string, Promise<ProceduralSfxLibraryV1>>();
export function originalSfxRootV1(runtime: OriginalSfxRuntimeV1) {
  const host = runtime.personalMusicRoot;
  if (!host || !isAbsolute(host) || /^[\\/]{2}/.test(host) || /[\u0000-\u001f]/.test(host) || host.split(/[\\/]/).includes("..")) throw new Error("SFX_HOST_STORAGE_NOT_CONFIGURED");
  return join(dirname(resolve(host)), "original-sfx-v1");
}
async function plainExistingAncestors(path: string) {
  for (let p = resolve(path);; p = dirname(p)) {
    try { const info = await lstat(p); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("SFX_HOST_STORAGE_LINK_INVALID"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (p === dirname(p)) break;
  }
}
async function library(runtime: OriginalSfxRuntimeV1, allowGeneration: boolean): Promise<ProceduralSfxLibraryV1> {
  const root = originalSfxRootV1(runtime), key = root.toLowerCase();
  const inFlight = pending.get(key); if (inFlight) return inFlight;
  const run = (async () => {
    let exists = true;
    try { await lstat(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; exists = false; }
    if (!exists) {
      if (!allowGeneration) throw new Error("SFX_CANDIDATES_NOT_GENERATED");
      await plainExistingAncestors(dirname(root)); await mkdir(dirname(root), { recursive: true });
      await plainExistingAncestors(dirname(root)); await writeProceduralSfxPackV1(root, ORIGINAL_SFX_GENERATOR_PINS_V1);
    }
    // Incomplete/corrupt existing roots are preserved and rejected; never delete or regenerate them.
    return createProceduralSfxLibraryV1(root, ORIGINAL_SFX_GENERATOR_PINS_V1);
  })();
  pending.set(key, run);
  try { return await run; } finally { if (pending.get(key) === run) pending.delete(key); }
}
export function originalSfxListRequestedV1(payload: unknown): boolean {
  const value = z.strictObject({ includeOriginalSfxCandidates: z.boolean().optional() }).parse(payload);
  return value.includeOriginalSfxCandidates === true;
}
function candidateAsset(entry: Awaited<ReturnType<ProceduralSfxLibraryV1["resolve"]>>["entry"]): OriginalSfxCandidateAssetV1 {
  return { id: entry.id, name: entry.name, category: "original-sfx-candidate", role: "sound-effect", domains: [], mediaKind: "audio", bytes: entry.bytes,
    duration: entry.durationSeconds, license: "Original; private-owner-only", provenance: `Local original mathematical synthesis; source-sha256=${entry.sourceSha256}; wav-sha256=${entry.sha256}`,
    sourceFilename: `${entry.kind}-${entry.id.slice(-2)}.wav`, rightsBasis: entry.rightsBasis, distributionScope: "private-owner-only", redistributable: false,
    certification: "AUDIO_PENDING_HAO_CLAUDE", defaultEnabled: false };
}
/** The explicit UI list request is the only operation that creates missing owned candidates. */
export async function listOriginalSfxCandidatesV1(runtime: OriginalSfxRuntimeV1): Promise<OriginalSfxCandidateSummaryV1> {
  const host = await library(runtime, true), a = await host.list(), b = await host.list({ offset: a.nextOffset }), assets = [...a.entries, ...b.entries].map(candidateAsset);
  const summary: OriginalSfxCandidateSummaryV1 = { id: "editkin-original-sfx-candidates-v1", name: "Editkin original SFX candidates", version: "1", attribution: "Original local mathematical synthesis",
    assetCount: 40, assetBytes: assets.reduce((n, a) => n + a.bytes, 0), assets, musicAssetCount: 0, sfxAssetCount: 40, restrictedAssetCount: 40, candidateOnly: true, defaultEnabled: false };
  assertOriginalSfxCandidateSummaryV1(summary); return summary;
}
export async function resolveOriginalSfxCandidateV1(payload: unknown, runtime: OriginalSfxRuntimeV1): Promise<ResolvedCreativeAsset> {
  const request = z.strictObject({ assetId: z.string().refine(isOriginalSfxCandidateIdV1), mode: z.enum(["poster", "media"]).optional() }).parse(payload);
  const host = await library(runtime, false), page = await host.list({ kind: proceduralSfxRecipeV1(request.assetId).kind }),
    entry = page.entries.find(e => e.id === request.assetId);
  if (!entry) throw new Error("SFX_CANDIDATE_NOT_FOUND");
  const resolved = await host.resolve({ id: entry.id, sha256: entry.sha256 });
  return { asset: candidateAsset(resolved.entry), absolutePath: resolved.absolutePath, sha256: resolved.entry.sha256 };
}
/** Preserve the exact legacy path when no candidate URI occurs. */
export async function materializeOriginalSfxCandidatesV1(project: EditProject, runtime: OriginalSfxRuntimeV1): Promise<EditProject> {
  if (!runtime.creativePackRoot) return project;
  const matches = project.assets.map(a => ({ asset: a, id: creativeAssetIdFromUri(a.uri) })).filter(r => r.id && isOriginalSfxCandidateIdV1(r.id));
  if (!matches.length) return materializeCreativeAssets(project, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot);
  const paths = new Map<string, string>();
  for (const { id } of matches) if (!paths.has(id!)) paths.set(id!, (await resolveOriginalSfxCandidateV1({ assetId: id! }, runtime)).absolutePath);
  const candidate = { ...project, assets: project.assets.map(a => { const id = creativeAssetIdFromUri(a.uri); return id && paths.has(id) ? { ...a, uri: paths.get(id)! } : a; }) };
  return materializeCreativeAssets(candidate, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot);
}
