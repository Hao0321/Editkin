import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import * as z from "zod/v4";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditProject, MediaAsset } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveMediaPath } from "../render/mediaProcess";
import { encodeProjectBytes } from "./projectCodec";
import { musicBeatFileShaV1, type MusicBeatsRuntimeV1 } from "./musicBeats";
import { analyzeMusicBeatEnergySourceV1 } from "./musicBeatEnergySourceV1";
import { musicRhythmEventsInWindowV2, type MusicRhythmEventV2 } from "./musicRhythmV2";
import { beatMontageClockV2, beatMontageRequestSchemaV2, compileBeatAlignedMontageV2, type BeatMontageRequestV2 } from "./beatMontageCompilerV2";
import { beatMontageStyleSchemaV2, getBeatMontagePresetV2 } from "./beatMontagePresetsV2";

const id = z.string().trim().min(1).max(128), digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const easyMusicMontageInputSchemaV1 = z.strictObject({
  assetBase: z.string().min(1).max(4096), musicAssetId: id, musicSourceStartSeconds: z.number().finite().min(0).max(604800),
  analysisDurationSeconds: z.number().finite().min(.25).max(60), priorBpm: z.number().finite().min(30).max(300).optional(), rhythmRefinementV2: z.literal(true).optional(),
  rightsEvidenceRefs: z.array(z.string().trim().min(1).max(1024)).min(1).max(16),
  candidates: beatMontageRequestSchemaV2.shape.candidates,
  sources: z.array(z.strictObject({ assetId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(2).max(513),
});
export const easyMusicMontageStyleRequestSchemaV1 = z.strictObject({
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), title: z.string().trim().min(1).max(160),
  createdAt: z.iso.datetime(), style: beatMontageStyleSchemaV2, allowInferredBarEnd: z.boolean().default(false),
  transition: z.strictObject({ kernel: z.enum(["dissolve", "dip"]), beforeFrames: z.number().int().min(0).max(12), afterFrames: z.number().int().min(0).max(12) }).optional(),
  authoredFlashes: z.boolean().default(false),
});
export interface PreparedEasyMusicMontageV1 {
  readonly schema: "editkin.prepared-music-montage/v1"; readonly sourceProjectId: string; readonly energyEvidenceSha256: string;
  readonly sourceAssets: number; readonly sourceProjectChanged: false; readonly defaultEnabled: false;
}
type SourceFile = { path: string; sha256: string; bytes: number; assetId?: string };
type Context = {
  current: () => EditProject; source: EditProject; fingerprint: string; input: z.infer<typeof easyMusicMontageInputSchemaV1>;
  assets: MediaAsset[]; files: SourceFile[]; energy: Awaited<ReturnType<typeof analyzeMusicBeatEnergySourceV1>>;
  signal?: AbortSignal; timeoutMs: number;
};
const prepared = new WeakMap<PreparedEasyMusicMontageV1, Context>();
async function deadline<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal, remaining: () => number) => Promise<T>) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error("MUSIC_MONTAGE_TIMEOUT_INVALID");
  signal?.throwIfAborted(); const owner = new AbortController(), abort = () => owner.abort(signal?.reason), start = Date.now();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => owner.abort(Error("MUSIC_MONTAGE_TOTAL_TIMEOUT")), timeoutMs);
  try { return await work(owner.signal, () => Math.max(1, timeoutMs - (Date.now() - start))); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
function assertCurrent(c: Context) {
  c.signal?.throwIfAborted(); if (digest(c.current()) !== c.fingerprint) throw Error("MUSIC_MONTAGE_SOURCE_PROJECT_CHANGED");
}
async function checkFiles(files: readonly SourceFile[], signal: AbortSignal) {
  for (const expected of files) {
    signal.throwIfAborted(); const actual = await musicBeatFileShaV1(expected.path, signal);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw Error("MUSIC_MONTAGE_SOURCE_OR_TOOL_CHANGED");
  }
}

/** Package-owned preparation only. Resolves selected project assets, never a caller alternative media path. */
export async function prepareEasyMusicMontageV1(getCurrentProject: () => EditProject, value: unknown, requestedRuntime: MusicBeatsRuntimeV1) {
  const input = easyMusicMontageInputSchemaV1.parse(value), runtime = Object.freeze({ ...requestedRuntime }), source = structuredClone(getCurrentProject());
  encodeProjectBytes(source); const fingerprint = digest(source), timeoutMs = runtime.timeoutMs ?? 120000;
  if (!isAbsolute(input.assetBase) || resolve(input.assetBase) !== input.assetBase) throw Error("MUSIC_MONTAGE_HOST_ASSET_BASE_REQUIRED");
  const wanted = new Set([input.musicAssetId, ...input.candidates.map(c => c.assetId)]), sources = new Map(input.sources.map(s => [s.assetId, s.sha256]));
  if (sources.size !== input.sources.length || sources.size !== wanted.size || [...wanted].some(key => !sources.has(key))) throw Error("MUSIC_MONTAGE_SOURCE_IDENTITY_CLOSURE_REQUIRED");
  const music = source.assets.find(a => a.id === input.musicAssetId);
  if (!music || music.kind !== "audio") throw Error("MUSIC_MONTAGE_MUSIC_ASSET_REQUIRED");
  const assets: MediaAsset[] = [], files: SourceFile[] = [];
  return deadline(runtime.signal, timeoutMs, async (signal, remaining) => {
    for (const assetId of wanted) {
      const asset = source.assets.find(a => a.id === assetId);
      if (!asset || asset.kind !== (assetId === music.id ? "audio" : "video")) throw Error("MUSIC_MONTAGE_SELECTED_ASSET_INVALID");
      const path = resolve(resolveMediaPath(asset.uri, input.assetBase)), identity = await musicBeatFileShaV1(path, signal);
      if (identity.sha256 !== sources.get(asset.id)) throw Error("MUSIC_MONTAGE_EXPECTED_SOURCE_SHA_CHANGED");
      files.push({ assetId: asset.id, path, ...identity });
      const { derivatives: _derivatives, ...original } = asset; assets.push({ ...original, uri: path });
    }
    const musicFile = files.find(f => f.assetId === music.id)!;
    const energy = await analyzeMusicBeatEnergySourceV1({ sourcePath: musicFile.path, expectedSourceSha256: musicFile.sha256,
      sourceStartSeconds: input.musicSourceStartSeconds, durationSeconds: input.analysisDurationSeconds,
      ...(input.priorBpm === undefined ? {} : { priorBpm: input.priorBpm }), ...(input.rhythmRefinementV2 ? { rhythmRefinementV2: true } : {}) },
      { ...runtime, signal, timeoutMs: remaining() });
    for (const [path, identity] of [[runtime.ffmpegPath, energy.binding.ffmpeg], [runtime.ffprobePath, energy.binding.ffprobe], [runtime.nativeCorePath, energy.binding.core]] as const)
      files.push({ path, ...identity });
    const context: Context = { current: getCurrentProject, source, fingerprint, input, assets, files, energy, signal: runtime.signal, timeoutMs };
    await checkFiles(files, signal); signal.throwIfAborted(); assertCurrent(context);
    const packet: PreparedEasyMusicMontageV1 = Object.freeze({ schema: "editkin.prepared-music-montage/v1", sourceProjectId: source.id,
      energyEvidenceSha256: energy.evidenceSha256, sourceAssets: wanted.size, sourceProjectChanged: false, defaultEnabled: false });
    prepared.set(packet, context); return packet;
  });
}
function contextFor(packet: PreparedEasyMusicMontageV1) {
  const c = prepared.get(packet); if (!c) throw Error("MUSIC_MONTAGE_LIVE_PREPARATION_REQUIRED"); assertCurrent(c); return c;
}
function barsFor(c: Context): MusicRhythmEventV2[] {
  const a = c.energy.nativeAnalysis.receipt.analysis, request = c.energy.binding.request;
  return request.rhythmRefinementV2 ? musicRhythmEventsInWindowV2(a, { sourceStartSeconds: a.sourceStartSeconds,
    sourceEndSeconds: a.sourceStartSeconds + a.durationSeconds, priorBpm: request.priorBpm, maximumEvents: 129, include: "bars" }).bars
    : a.beats.flatMap((b, i) => b.downbeat ? [{ timeSeconds: b.timeSeconds, confidence: b.downbeatConfidence, inferred: false, leftNativeIndex: i, rightNativeIndex: null }] : []);
}

/** Explicit restyle compiles from the same measured context. It grants no apply/approval authority. */
export function compileEasyMusicMontageV1(packet: PreparedEasyMusicMontageV1, value: unknown) {
  const c = contextFor(packet), options = easyMusicMontageStyleRequestSchemaV1.parse(value), preset = getBeatMontagePresetV2(options.style), fps = c.source.fps;
  if (options.projectId === c.source.id) throw Error("MUSIC_MONTAGE_NEW_PROJECT_ID_REQUIRED");
  if (options.authoredFlashes && !preset.authoredFlashAllowed) throw Error("MUSIC_MONTAGE_FLASH_NOT_ALLOWED_FOR_STYLE");
  const bars = barsFor(c).filter(b => options.allowInferredBarEnd || !b.inferred), pulses = c.energy.layout.pulses;
  const endingBar = bars.at(-1); if (!endingBar || endingBar.timeSeconds <= pulses[0].timeSeconds) throw Error("MUSIC_MONTAGE_ELIGIBLE_ENDING_BAR_REQUIRED");
  let last = 0;
  for (let i = 1; i < pulses.length; i++) if (Math.abs(pulses[i].timeSeconds - endingBar.timeSeconds) < Math.abs(pulses[last].timeSeconds - endingBar.timeSeconds)) last = i;
  if (last < 1 || Math.abs(pulses[last].timeSeconds - endingBar.timeSeconds) * fps > .5 + 1e-7) throw Error("MUSIC_MONTAGE_ENDING_BAR_NOT_ON_SOURCE_PULSE");
  const firstSource = pulses[0].timeSeconds, musicStart = Math.round(firstSource * fps) / fps;
  const beats = pulses.slice(0, last + 1).map((p, i) => ({ timeSeconds: p.timeSeconds - firstSource,
    energy: i === last ? 0 : c.energy.energy.intervals[i].normalizedLevel,
    downbeat: bars.some(b => Math.abs(b.timeSeconds - p.timeSeconds) * fps <= .5 + 1e-7) }));
  const seed = createEmptyProject(options.title, { id: options.projectId, width: c.source.width, height: c.source.height, fps });
  seed.updatedAt = seed.director.updatedAt = options.createdAt; seed.assets = structuredClone(c.assets);
  const request: BeatMontageRequestV2 = { targetTrackId: "video-main", idPrefix: options.projectId + "-m", beats,
    pace: { lowThreshold: preset.lowThreshold, highThreshold: preset.highThreshold },
    candidates: c.input.candidates.map(candidate => ({ ...candidate, ...(candidate.focusTime === undefined && options.transition ? { focusTime: Math.round((candidate.sourceStart + candidate.sourceEnd) / 2 * fps) / fps } : {}) })),
    music: { assetId: c.input.musicAssetId, trackId: "audio-main", clipId: options.projectId + "-music", sourceStart: musicStart,
      sourceSha256: c.energy.binding.source.sha256, rightsEvidenceRefs: [...c.input.rightsEvidenceRefs] } };
  const clock = beatMontageClockV2(request, fps), cuts = clock.boundaries.slice(1, -1).flatMap((b, i) => Number.isInteger(b.beatPosition) && beats[b.beatPosition].downbeat ? [i + 1] : []);
  if (options.transition) request.pairs = { ...options.transition, cutIndices: cuts };
  if (options.authoredFlashes) request.flashes = { cutIndices: cuts, durationFrames: Math.max(1, Math.round(fps / 30)) };
  const compiled = compileBeatAlignedMontageV2(seed, request), used = new Set([c.input.musicAssetId, ...compiled.selections.map(s => s.assetId)]);
  seed.assets = seed.assets.filter(a => used.has(a.id));
  const windows = new Map<string, { start: number; end: number }[]>();
  for (const clip of compiled.selections) {
    const file = c.files.find(f => f.assetId === clip.assetId)!, previous = windows.get(file.sha256) ?? [];
    if (previous.some(w => clip.sourceStart < w.end - 1e-6 && clip.sourceStart + clip.duration > w.start + 1e-6)) throw Error("MUSIC_MONTAGE_REPEATED_PHYSICAL_SOURCE_WINDOW");
    previous.push({ start: clip.sourceStart, end: clip.sourceStart + clip.duration }); windows.set(file.sha256, previous);
  }
  const alignment = compiled.clock.boundaries.map(b => ({ frame: b.frame, referenceSourceSeconds: firstSource + b.nominalSeconds,
    sourceErrorFrames: (musicStart + b.timeSeconds - firstSource - b.nominalSeconds) * fps }));
  const endingBarErrorFrames = (musicStart + compiled.music.duration - endingBar.timeSeconds) * fps;
  if (alignment.some(b => Math.abs(b.sourceErrorFrames) > 1 + 1e-7) || Math.abs(endingBarErrorFrames) > 1 + 1e-7
    || musicStart < c.input.musicSourceStartSeconds - 1e-9 || musicStart + compiled.music.duration > c.input.musicSourceStartSeconds + c.input.analysisDurationSeconds + 1e-9)
    throw Error("MUSIC_MONTAGE_QUANTIZED_MUSIC_WINDOW_OR_ALIGNMENT_INVALID");
  const command = { type: "batch" as const, commands: structuredClone(compiled.commands) }, scratch = applyCommand(seed, command);
  encodeProjectBytes(scratch); assertCurrent(c);
  const draft = { schema: "editkin.easy-music-montage-draft/v1" as const, status: "DRAFT_COMMAND_CANDIDATE" as const,
    seed, command, compiled, preset, energyEvidenceSha256: c.energy.evidenceSha256, sourceProjectId: c.source.id, sourceProjectFingerprint: c.fingerprint,
    endingBar: { ...endingBar }, endingBarErrorFrames, alignment, pulseProvenance: pulses.slice(0, last + 1).map(p => ({ ...p })),
    sourceBindings: c.files.map(f => ({ ...f })), sourceReadbackPending: true,
    evidenceAuthority: "measured_source_pcm_levels_caller_asserted_footage_salience_and_music_rights" as const,
    qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const, directApplyAllowed: false as const,
    mutationPerformed: false as const, vaDefaultEligible: false as const, materialDesignAutoColorAuditRequired: true as const,
    executionBoundary: "compile_only_existing_plan_audit_atomic_apply_required" as const };
  drafts.set(draft, { context: c, fingerprint: digest(draft), value: structuredClone(draft) }); return draft;
}
export type EasyMusicMontageDraftV1 = ReturnType<typeof compileEasyMusicMontageV1>;
const drafts = new WeakMap<EasyMusicMontageDraftV1, { context: Context; fingerprint: string; value: EasyMusicMontageDraftV1 }>();

/** Freshness readback for handoff into the existing audit path. It never dispatches or grants ACCEPTED. */
export async function recheckEasyMusicMontageDraftV1(draft: EasyMusicMontageDraftV1) {
  const owned = drafts.get(draft);
  if (!owned || digest(draft) !== owned.fingerprint) throw Error("MUSIC_MONTAGE_LIVE_UNCHANGED_DRAFT_REQUIRED");
  const c = owned.context; assertCurrent(c);
  return deadline(c.signal, c.timeoutMs, async signal => {
    await checkFiles(c.files, signal); signal.throwIfAborted(); assertCurrent(c);
    if (digest(draft) !== owned.fingerprint) throw Error("MUSIC_MONTAGE_DRAFT_CHANGED_DURING_READBACK");
    return { ...structuredClone(owned.value), sourceReadbackPending: false, sourceFilesRechecked: true,
      directApplyAllowed: false as const, mutationPerformed: false as const, materialDesignAutoColorAuditRequired: true as const };
  });
}
