import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { PROCEDURAL_SFX_CATALOGUE_V1, PROCEDURAL_SFX_RATE_V1, PROCEDURAL_SFX_REVISION_V1 } from "./proceduralSfxCatalogueV1";
import { encodeProceduralSfxWavV1, synthesizeProceduralSfxV1 } from "./proceduralSfxSynthV1";

export const PROCEDURAL_SFX_PACK_BUDGET_V1 = 6_000_000;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export interface SfxGeneratorSourceV1 { path: string; bytes: number; sha256: string }

/** Call only for an explicitly requested owned output directory. Never overwrites/cleans a pack. */
export async function writeProceduralSfxPackV1(outputDirectory: string, sources: readonly SfxGeneratorSourceV1[], signal?: AbortSignal) {
  if (!isAbsolute(outputDirectory)) throw new Error("SFX_OUTPUT_ABSOLUTE_REQUIRED");
  const target = resolve(outputDirectory), parent = dirname(target);
  if (target === parse(target).root || target === parent) throw new Error("SFX_OUTPUT_ROOT_REJECTED");
  if (sources.length !== 2 || new Set(sources.map(s => s.path)).size !== 2 || sources.some(s =>
    !/^src\/application\/proceduralSfx(?:Catalogue|Synth)V1\.ts$/.test(s.path) || !Number.isSafeInteger(s.bytes) || s.bytes < 1 || !/^[a-f0-9]{64}$/.test(s.sha256))) throw new Error("SFX_GENERATOR_SOURCE_IDENTITY_REQUIRED");
  for (let p = parent;; p = dirname(p)) {
    const entry = await lstat(p);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("SFX_OUTPUT_LINK_REJECTED");
    if (p === dirname(p)) break;
  }
  if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error("SFX_OUTPUT_ALIAS_REJECTED");
  const anticipated = PROCEDURAL_SFX_CATALOGUE_V1.reduce((sum, r) => sum + 44 + r.durationSamples * 2, 0);
  if (anticipated > PROCEDURAL_SFX_PACK_BUDGET_V1) throw new Error("SFX_PACK_BUDGET");
  signal?.throwIfAborted();
  await mkdir(target); // exclusive owner; an existing directory is refused
  await writeFile(join(target, "OWNER.json"), JSON.stringify({ revision: PROCEDURAL_SFX_REVISION_V1, sources, decision: "LONG-Q016", generationState: "candidate-not-certified" }, null, 2), { flag: "wx" });
  const items = [];
  for (const recipe of PROCEDURAL_SFX_CATALOGUE_V1) {
    signal?.throwIfAborted();
    const wav = encodeProceduralSfxWavV1(synthesizeProceduralSfxV1(recipe.id));
    const filename = `${recipe.kind}-${String(recipe.variant).padStart(2, "0")}.wav`, sourceFilename = `${filename}.SOURCE.json`;
    const provenance = { schema: "editkin.original-sfx-source/v1", recipe, generators: sources, sampleRate: PROCEDURAL_SFX_RATE_V1,
      channels: 1, encoding: "PCM16LE", wavSha256: sha(wav), wavBytes: wav.length, durationSeconds: recipe.durationSamples / PROCEDURAL_SFX_RATE_V1,
      originalRecordingsUsed: false, thirdPartySamplesUsed: false, networkUsed: false, publicRedistributionApproved: false };
    await writeFile(join(target, filename), wav, { flag: "wx" });
    await writeFile(join(target, sourceFilename), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
    items.push({ id: recipe.id, kind: recipe.kind, path: filename, sourceFilename, bytes: wav.length, sha256: provenance.wavSha256,
      durationSamples: recipe.durationSamples, certification: recipe.certification, defaultEnabled: false });
  }
  signal?.throwIfAborted();
  const manifest = { schema: "editkin.original-sfx-pack/v1", revision: PROCEDURAL_SFX_REVISION_V1, candidateCount: items.length,
    audioBytes: anticipated, distributionScope: "private-owner-only", defaultEnabled: false, items };
  await writeFile(join(target, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
