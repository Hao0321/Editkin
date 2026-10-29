import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import * as z from "zod/v4";
import { readBoundedFile } from "../shared/boundedFile";
import { proceduralSfxLibraryRequestV1Schema, type ProceduralSfxLibraryEntryV1, type ResolvedProceduralSfxV1 } from "../domain/proceduralSfxLibraryContractV1";
import { PROCEDURAL_SFX_CATALOGUE_V1 as catalogue, PROCEDURAL_SFX_REVISION_V1, type ProceduralSfxRecipeV1 } from "./proceduralSfxCatalogueV1";
import { synthesizeProceduralSfxV1, encodeProceduralSfxWavV1 } from "./proceduralSfxSynthV1";
import type { SfxGeneratorSourceV1 } from "./proceduralSfxPackV1";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.strictObject({ path: z.string().regex(/^src\/application\/proceduralSfx(?:Catalogue|Synth)V1\.ts$/), bytes: z.number().int().positive().max(1_000_000), sha256: digest });
const sourcesSchema = z.array(sourceSchema).length(2).refine(s => new Set(s.map(r => r.path)).size === 2);
const itemSchema = z.strictObject({ id: z.string(), kind: z.string(), path: z.string(), sourceFilename: z.string(), bytes: z.number().int().positive(),
  sha256: digest, durationSamples: z.number().int().positive(), certification: z.literal("AUDIO_PENDING_HAO_CLAUDE"), defaultEnabled: z.literal(false) });
const manifestSchema = z.strictObject({ schema: z.literal("editkin.original-sfx-pack/v1"), revision: z.literal(PROCEDURAL_SFX_REVISION_V1),
  candidateCount: z.literal(40), audioBytes: z.number().int().positive().max(6_000_000), distributionScope: z.literal("private-owner-only"), defaultEnabled: z.literal(false), items: z.array(itemSchema).length(40) });
const ownerSchema = z.strictObject({ revision: z.literal(PROCEDURAL_SFX_REVISION_V1), sources: sourcesSchema, decision: z.literal("LONG-Q016"), generationState: z.literal("candidate-not-certified") });
const provenanceSchema = z.strictObject({ schema: z.literal("editkin.original-sfx-source/v1"), recipe: z.record(z.string(), z.unknown()), generators: sourcesSchema,
  sampleRate: z.literal(48_000), channels: z.literal(1), encoding: z.literal("PCM16LE"), wavSha256: digest, wavBytes: z.number().int().positive(),
  durationSeconds: z.number().finite().positive(), originalRecordingsUsed: z.literal(false), thirdPartySamplesUsed: z.literal(false), networkUsed: z.literal(false), publicRedistributionApproved: z.literal(false) });

async function plainPath(path: string, directory: boolean) {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error("SFX_LIBRARY_PATH_INVALID");
  const target = resolve(path);
  if (target === parse(target).root) throw new Error("SFX_LIBRARY_ROOT_INVALID");
  for (let p = target;; p = dirname(p)) {
    const info = await lstat(p);
    if (info.isSymbolicLink() || (p !== target || directory ? !info.isDirectory() : !info.isFile())) throw new Error("SFX_LIBRARY_LINK_OR_TYPE_INVALID");
    if (p === target && !directory && info.nlink !== 1) throw new Error("SFX_LIBRARY_HARDLINK_INVALID");
    if (p === dirname(p)) break;
  }
  if ((await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("SFX_LIBRARY_ALIAS_INVALID");
  return target;
}
async function bounded(root: string, filename: string, maximum: number) {
  // Filenames below come exclusively from the fixed recipe catalogue.
  const path = await plainPath(join(root, filename), false), bytes = await readBoundedFile(path, maximum);
  await plainPath(path, false);
  return bytes;
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function matchingSources(actual: readonly SfxGeneratorSourceV1[], pins: readonly SfxGeneratorSourceV1[]) {
  return actual.length === pins.length && actual.every(a => pins.some(p => p.path === a.path && p.bytes === a.bytes && p.sha256 === a.sha256));
}
type Item = z.infer<typeof itemSchema>;
function filename(recipe: ProceduralSfxRecipeV1) { return `${recipe.kind}-${String(recipe.variant).padStart(2, "0")}.wav`; }

/** Host-only constructor. Renderer payloads cannot supply a root or trusted generator pins. */
export async function createProceduralSfxLibraryV1(configuredRoot: string, generatorPins: readonly SfxGeneratorSourceV1[]) {
  const pins = sourcesSchema.parse(generatorPins).map(p => Object.freeze({ ...p })), root = await plainPath(configuredRoot, true), rootIdentity = await lstat(root);
  const manifestBytes = await bounded(root, "MANIFEST.json", 65_536), manifestDigest = sha(manifestBytes);
  const mounted = manifestSchema.parse(json(manifestBytes)), ownerBytes = await bounded(root, "OWNER.json", 4096), ownerDigest = sha(ownerBytes), owner = ownerSchema.parse(json(ownerBytes));
  if (!matchingSources(owner.sources, pins)) throw new Error("SFX_GENERATOR_PIN_MISMATCH");
  const expectedAudioBytes = catalogue.reduce((n, r) => n + 44 + r.durationSamples * 2, 0);
  if (mounted.audioBytes !== expectedAudioBytes || new Set(mounted.items.map(i => i.id)).size !== 40) throw new Error("SFX_MANIFEST_CATALOGUE_MISMATCH");
  for (const recipe of catalogue) {
    const item = mounted.items.find(i => i.id === recipe.id), path = filename(recipe);
    if (!item || item.kind !== recipe.kind || item.path !== path || item.sourceFilename !== `${path}.SOURCE.json`
      || item.durationSamples !== recipe.durationSamples || item.bytes !== 44 + recipe.durationSamples * 2) throw new Error("SFX_MANIFEST_CATALOGUE_MISMATCH");
  }
  async function current(signal?: AbortSignal) {
    signal?.throwIfAborted(); await plainPath(root, true);
    const info = await lstat(root);
    if (info.dev !== rootIdentity.dev || info.ino !== rootIdentity.ino) throw new Error("SFX_LIBRARY_OWNER_CHANGED");
    if (sha(await bounded(root, "MANIFEST.json", 65_536)) !== manifestDigest || sha(await bounded(root, "OWNER.json", 4096)) !== ownerDigest) throw new Error("SFX_LIBRARY_MANIFEST_CHANGED");
    signal?.throwIfAborted();
  }
  async function entry(item: Item, signal?: AbortSignal): Promise<ProceduralSfxLibraryEntryV1> {
    signal?.throwIfAborted();
    const recipe = catalogue.find(r => r.id === item.id)!, bytes = await bounded(root, item.sourceFilename, 4096), provenance = provenanceSchema.parse(json(bytes));
    if (Object.keys(provenance.recipe).length !== Object.keys(recipe).length || Object.entries(recipe).some(([k, v]) => provenance.recipe[k] !== v)
      || !matchingSources(provenance.generators, pins) || provenance.wavSha256 !== item.sha256 || provenance.wavBytes !== item.bytes
      || provenance.durationSeconds !== recipe.durationSamples / 48_000) throw new Error("SFX_SOURCE_BINDING_MISMATCH");
    return { id: item.id, name: `Editkin ${recipe.kind} ${recipe.variant}`, kind: recipe.kind, sha256: item.sha256, bytes: item.bytes,
      durationSamples: recipe.durationSamples, durationSeconds: recipe.durationSamples / 48_000, sourceSha256: sha(bytes), source: recipe.source,
      rightsBasis: recipe.rightsBasis, distributionScope: recipe.distributionScope, certification: recipe.certification,
      defaultEnabled: false, redistributable: false, contentVerified: false };
  }
  async function request(payload: unknown, signal?: AbortSignal) {
    const value = proceduralSfxLibraryRequestV1Schema.parse(payload);
    await current(signal);
    if (value.operation === "list") {
      const filtered = mounted.items.filter(i => !value.kind || i.kind === value.kind), page = filtered.slice(value.offset, value.offset + value.limit), entries = [];
      for (const item of page) entries.push(await entry(item, signal));
      await current(signal);
      return { operation: "list" as const, entries, total: filtered.length, ...(value.offset + entries.length < filtered.length ? { nextOffset: value.offset + entries.length } : {}) };
    }
    const item = mounted.items.find(i => i.id === value.id);
    if (!item || item.sha256 !== value.sha256) throw new Error("SFX_ASSET_REFERENCE_MISMATCH");
    const metadata = await entry(item, signal), wav = await bounded(root, item.path, 96_044);
    // Recompute the original candidate; a forged self-consistent manifest cannot substitute different audio.
    const pcm = synthesizeProceduralSfxV1(item.id), expected = encodeProceduralSfxWavV1(pcm);
    if (wav.length !== item.bytes || sha(wav) !== item.sha256 || sha(expected) !== item.sha256 || !wav.equals(Buffer.from(expected))) throw new Error("SFX_ORIGINAL_CONTENT_MISMATCH");
    signal?.throwIfAborted(); await current(signal);
    return { operation: "resolve" as const, entry: { ...metadata, contentVerified: true }, absolutePath: join(root, item.path), pcm };
  }
  return Object.freeze({
    list: async (payload: { offset?: number; limit?: number; kind?: ProceduralSfxLibraryEntryV1["kind"] } = {}, signal?: AbortSignal) => {
      const result = await request({ ...payload, operation: "list" }, signal);
      if (result.operation !== "list") throw new Error("SFX_LIBRARY_REPLY_INVALID");
      return { entries: result.entries, total: result.total, ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}) };
    },
    resolve: async (reference: { id: string; sha256: string }, signal?: AbortSignal): Promise<ResolvedProceduralSfxV1> => {
      const result = await request({ ...reference, operation: "resolve" }, signal);
      if (result.operation !== "resolve") throw new Error("SFX_LIBRARY_REPLY_INVALID");
      return { entry: result.entry, absolutePath: result.absolutePath, pcm: result.pcm };
    },
  });
}
export type ProceduralSfxLibraryV1 = Awaited<ReturnType<typeof createProceduralSfxLibraryV1>>;
