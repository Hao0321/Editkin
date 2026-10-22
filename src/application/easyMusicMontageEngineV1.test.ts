import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import type { EditProject } from "../domain/types";
import { buildRenderPlan } from "../render/planner";
import { canonicalJson } from "../shared/canonicalJson";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
import { musicBeatsReceiptSchemaV1 } from "./musicBeatsTypesV1";
import { planMusicBeatEnergyV1, createMusicBeatEnergyAccumulatorV1 } from "./musicBeatEnergyV1";
import { analyzeMusicBeatEnergySourceV1 } from "./musicBeatEnergySourceV1";
import { compileEasyMusicMontageV1, prepareEasyMusicMontageV1, recheckEasyMusicMontageDraftV1 } from "./easyMusicMontageEngineV1";

vi.mock("./musicBeatEnergySourceV1", () => ({ analyzeMusicBeatEnergySourceV1: vi.fn() }));
const analyze = vi.mocked(analyzeMusicBeatEnergySourceV1), sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string, folder: string, current: EditProject, input: Record<string, any>, runtime: { ffmpegPath: string; ffprobePath: string; nativeCorePath: string; cacheRoot: string; signal?: AbortSignal };
let measured: Awaited<ReturnType<typeof analyzeMusicBeatEnergySourceV1>>;
const options = (style = "travel") => ({ projectId: "new-" + style, title: style, style, createdAt: "2026-10-17T00:00:00.000Z" });
const prepare = () => prepareEasyMusicMontageV1(() => current, input, runtime);
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "montage-source-test-")); });
afterAll(async () => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("montage-source-test-")) throw Error("Unexpected own test root");
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  folder = await mkdtemp(join(root, "case-"));
  const video = join(folder, "original-video.mp4"), music = join(folder, "original-music.wav");
  await writeFile(video, "original video fixture"); await writeFile(music, "0123456789");
  runtime = { ffmpegPath: join(folder, "ffmpeg.exe"), ffprobePath: join(folder, "ffprobe.exe"), nativeCorePath: join(folder, "hao-core.exe"), cacheRoot: folder };
  for (const path of [runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath]) await writeFile(path, path);
  const identity = async (path: string) => { const bytes = await readFile(path); return { sha256: sha(bytes), bytes: bytes.length }; };
  current = createEmptyProject("source", { id: "source", width: 320, height: 180, fps: 24 });
  current.assets = [{ id: "video", name: "raw video", kind: "video", uri: video, duration: 200 },
    { id: "music", name: "original music", kind: "audio", uri: music, duration: 8 }];
  const source = await identity(music), ffmpeg = await identity(runtime.ffmpegPath), ffprobe = await identity(runtime.ffprobePath), core = await identity(runtime.nativeCorePath);
  const raw = fixtureReceiptV1(8); raw.sourceSha256 = source.sha256; raw.ffmpegSha256 = ffmpeg.sha256;
  raw.analysis.beats = Array.from({ length: 16 }, (_, i) => ({ timeSeconds: .25 + i * .5, confidence: .8, downbeat: i % 4 === 0, downbeatConfidence: i % 4 === 0 ? .7 : 0 }));
  const receipt = musicBeatsReceiptSchemaV1.parse(raw), request = { sourcePath: music, sourceStartSeconds: 0, durationSeconds: 8 };
  const layout = planMusicBeatEnergyV1(receipt, request), acc = createMusicBeatEnergyAccumulatorV1(layout), pcm = new Float32Array(128000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = [.2, .4, .8, 1][Math.max(0, Math.floor((i - 4000) / 8000)) % 4];
  const bytes = new Uint8Array(pcm.buffer); for (let n = 0; n < bytes.length; n += 65536) acc.push(bytes.subarray(n, n + 65536));
  const energy = acc.finish();
  measured = { schema: "editkin.music-beat-energy-source/v1", binding: { schema: "editkin.music-beat-energy-binding/v1", request, source, ffmpeg, ffprobe, core,
    nativeAnalysisKey: "a".repeat(64), nativeReceiptSha256: "b".repeat(64), sampleBoundaryPolicy: "nearest-source-sample", normalization: energy.normalization,
    pcmSha256: "c".repeat(64), nativePcmExact: true, sourceFilesRecheckedAfterDecode: true }, layout, energy, evidenceSha256: "d".repeat(64),
    nativeAnalysis: { key: "a".repeat(64), receiptSha256: "b".repeat(64), binding: { schema: "editkin.music-beats-cache-key/v1", source, ffmpeg, ffprobe, core,
      sourceStartSeconds: 0, durationSeconds: 8, priorBpm: null, analysisRecipe: "spectral-flux-autocorrelation-dp-native/v1" }, receipt, cacheHit: true, elapsedMs: 1 },
    nativeCacheHit: true, rmsDecodeCalls: 1, pcmCapturedOrStagedBytes: 0, elapsedMs: 1, projectEdits: 0, defaultEnabled: false, humanMusicalEnergyCertified: false };
  input = { assetBase: folder, musicAssetId: "music", musicSourceStartSeconds: 0, analysisDurationSeconds: 8, rightsEvidenceRefs: ["original-owner-source"],
    candidates: Array.from({ length: 64 }, (_, i) => ({ shotId: "shot-" + i, assetId: "video", sourceStart: i * 2, sourceEnd: i * 2 + 2, salience: i / 64, storyOrder: i })),
    sources: [{ assetId: "music", sha256: source.sha256 }, { assetId: "video", sha256: (await identity(video)).sha256 }] };
  analyze.mockReset(); analyze.mockResolvedValue(measured);
});

describe("source-bound explicit montage drafts", () => {
  it("prepares once, produces three distinct drafts, retains the source and never grants apply authority", async () => {
    const before = canonicalJson(current), packet = await prepare(), drafts = ["travel", "food", "hype"].map(style => compileEasyMusicMontageV1(packet, options(style)));
    expect(drafts.map(d => d.compiled.selections.length)).toEqual([12, 15, 18]); expect(analyze).toHaveBeenCalledTimes(1);
    expect(canonicalJson(current)).toBe(before);
    for (const d of drafts) {
      expect(d).toMatchObject({ directApplyAllowed: false, mutationPerformed: false, materialDesignAutoColorAuditRequired: true, defaultEnabled: false, vaDefaultEligible: false });
      expect(d.compiled.directApplyAllowed).toBe(false); expect(d.command.commands.every(c => c.type !== "batch")).toBe(true);
      expect(d.alignment.every(p => Math.abs(p.sourceErrorFrames) <= 1 + 1e-7)).toBe(true); expect(Math.abs(d.endingBarErrorFrames)).toBeLessThanOrEqual(1);
    }
  });
  it("the unchanged batch is one real Undo/Redo with exact codec and music-only render planning", async () => {
    const d = compileEasyMusicMontageV1(await prepare(), options()), verified = await recheckEasyMusicMontageDraftV1(d);
    expect(verified.sourceReadbackPending).toBe(false); expect(verified.directApplyAllowed).toBe(false);
    const history = dispatchCommand(createHistory(verified.seed), verified.command), reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(history.past).toHaveLength(1); expect(undo(history).present.tracks[0].clips).toEqual([]);
    expect(redo(undo(history)).present.tracks[0].clips).toEqual(history.present.tracks[0].clips);
    expect(reopened.tracks[0].clips.every(c => c.volume === 0)).toBe(true);
    expect(buildRenderPlan(reopened, uri => uri).audioClips.map(c => c.clip.assetId)).toEqual(["music"]);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it("uses only explicit dissolve/dip handles and optional hype authored flashes", async () => {
    const packet = await prepare();
    const d = compileEasyMusicMontageV1(packet, { ...options("hype"), transition: { kernel: "dip", beforeFrames: 2, afterFrames: 2 }, authoredFlashes: true });
    expect(d.compiled.pairs.length).toBeGreaterThan(0); expect(d.compiled.flashEvents.length).toBeGreaterThan(0);
    expect(d.compiled.pairs.every(p => p.kernel === "dip")).toBe(true);
    expect(() => compileEasyMusicMontageV1(packet, { ...options("food"), authoredFlashes: true })).toThrow(/FLASH_NOT_ALLOWED/);
  });
  it("preserves source-clock alignment at fractional project FPS", async () => {
    current.fps = 30000 / 1001;
    input.candidates = input.candidates.map((c: any, i: number) => ({ ...c, sourceStart: i * 60 / current.fps, sourceEnd: (i + 1) * 60 / current.fps }));
    const d = compileEasyMusicMontageV1(await prepare(), options());
    expect(d.alignment.every(p => Math.abs(p.sourceErrorFrames) <= 1)).toBe(true);
  });
  it("rejects an unclosed identity set and mismatched physical source before RMS analysis", async () => {
    input.sources.push({ ...input.sources[0] }); await expect(prepare()).rejects.toThrow(/IDENTITY_CLOSURE/);
    input.sources.pop(); input.sources[1].sha256 = "f".repeat(64); await expect(prepare()).rejects.toThrow(/EXPECTED_SOURCE_SHA/);
    expect(analyze).not.toHaveBeenCalled();
  });
  it("refuses files changed during preparation", async () => {
    analyze.mockImplementationOnce(async () => { await appendFile(current.assets[0].uri, "changed"); return measured; });
    await expect(prepare()).rejects.toThrow(/SOURCE_OR_TOOL_CHANGED/);
  });
  it("snapshots options and runtime paths across asynchronous preparation", async () => {
    const original = runtime.ffmpegPath;
    analyze.mockImplementationOnce(async () => { input.candidates[0].sourceStart = 100; runtime.ffmpegPath = "wrong.exe"; return measured; });
    const d = compileEasyMusicMontageV1(await prepare(), options()); expect(d.sourceBindings.some(f => f.path === original)).toBe(true);
  });
  it("refuses source project replacement before restyle and after physical readback", async () => {
    const packet = await prepare(), d = compileEasyMusicMontageV1(packet, options()); current = { ...current, revision: current.revision + 1 };
    expect(() => compileEasyMusicMontageV1(packet, options("food"))).toThrow(/SOURCE_PROJECT_CHANGED/);
    await expect(recheckEasyMusicMontageDraftV1(d)).rejects.toThrow(/SOURCE_PROJECT_CHANGED/);
  });
  it.each(["video", "ffmpeg"]) ("refuses %s bytes changed after review", async kind => {
    const d = compileEasyMusicMontageV1(await prepare(), options()); await appendFile(kind === "video" ? current.assets[0].uri : runtime.ffmpegPath, "changed");
    await expect(recheckEasyMusicMontageDraftV1(d)).rejects.toThrow(/SOURCE_OR_TOOL_CHANGED/);
  });
  it("refuses forged preparations, serialized drafts and modified commands", async () => {
    const packet = await prepare(), d = compileEasyMusicMontageV1(packet, options());
    expect(() => compileEasyMusicMontageV1(JSON.parse(JSON.stringify(packet)), options())).toThrow(/LIVE_PREPARATION/);
    await expect(recheckEasyMusicMontageDraftV1(JSON.parse(JSON.stringify(d)))).rejects.toThrow(/LIVE_UNCHANGED_DRAFT/);
    (d.command.commands[0] as any).clip.sourceStart += 1; await expect(recheckEasyMusicMontageDraftV1(d)).rejects.toThrow(/LIVE_UNCHANGED_DRAFT/);
  });
  it("refuses mutation during physical readback", async () => {
    const d = compileEasyMusicMontageV1(await prepare(), options()), pending = recheckEasyMusicMontageDraftV1(d);
    d.seed.name = "changed"; await expect(pending).rejects.toThrow(/DRAFT_CHANGED_DURING_READBACK/);
  });
  it("obtains the latest project again after asynchronous file readback", async () => {
    const d = compileEasyMusicMontageV1(await prepare(), options()), pending = recheckEasyMusicMontageDraftV1(d);
    current = { ...current, revision: current.revision + 1 }; await expect(pending).rejects.toThrow(/SOURCE_PROJECT_CHANGED/);
  });
  it("requires explicit opt-in for an inferred ending bar and retains its low confidence", async () => {
    const a = measured.nativeAnalysis.receipt.analysis;
    a.beats.forEach(b => { b.downbeat = false; b.downbeatConfidence = 0; });
    a.rhythmV2 = { schema: "editkin.music-rhythm-refinement/v2", policy: "prior-octave-four-beat-candidate/v2",
      tempo: { rawBpm: 120, bpm: 120, priorBpm: 120, octaveMultiplier: 1, state: "unchanged", confidence: .8 },
      pulseRecipe: { mode: "native-observed", phase: 0 }, bars: { mode: "inferred-four-beat-grid", beatsPerBar: 4,
        anchorSourceSeconds: .25, anchorNativeIndex: 0, periodSeconds: 2, confidence: .16, inferred: true, reason: "weak-accent-first-beat-anchor" },
      nativeBeatCount: 16, nativeDownbeatCount: 0, regularIntervalFraction: 1, humanQualityCertified: false };
    measured.binding.request.priorBpm = 120; measured.binding.request.rhythmRefinementV2 = true;
    input.rhythmRefinementV2 = true; input.priorBpm = 120;
    const packet = await prepare(); expect(() => compileEasyMusicMontageV1(packet, options())).toThrow(/ELIGIBLE_ENDING_BAR/);
    const d = compileEasyMusicMontageV1(packet, { ...options(), allowInferredBarEnd: true });
    expect(d.endingBar).toMatchObject({ inferred: true, confidence: .16 }); expect(d.directApplyAllowed).toBe(false);
  });
  it("refuses cancelled context and insufficient distinct shot evidence", async () => {
    const controller = new AbortController(); runtime.signal = controller.signal;
    const packet = await prepare(); controller.abort(); expect(() => compileEasyMusicMontageV1(packet, options())).toThrow();
    runtime.signal = undefined; input.candidates = input.candidates.slice(0, 1);
    expect(() => compileEasyMusicMontageV1(packet, options())).toThrow();
    const few = await prepare(); expect(() => compileEasyMusicMontageV1(few, options())).toThrow(/沒有足夠/);
  });
  it("requires an eligible downbeat and a genuinely new target project id", async () => {
    measured.nativeAnalysis.receipt.analysis.beats.forEach(b => { b.downbeat = false; b.downbeatConfidence = 0; });
    const packet = await prepare(); expect(() => compileEasyMusicMontageV1(packet, options())).toThrow(/ELIGIBLE_ENDING_BAR/);
    expect(() => compileEasyMusicMontageV1(packet, { ...options(), projectId: current.id })).toThrow(/NEW_PROJECT_ID/);
  });
  it("different URI/asset aliases cannot conceal overlapping windows of one physical file", async () => {
    const video = current.assets[0], candidates = [], sources = [input.sources[0]];
    current.assets = [current.assets[1]];
    for (let i = 0; i < 12; i++) {
      const path = join(folder, "alias-" + i + ".mp4"); await copyFile(video.uri, path); const assetId = "alias-" + i;
      current.assets.push({ ...video, id: assetId, uri: path }); sources.push({ assetId, sha256: sha(await readFile(path)) });
      candidates.push({ shotId: "alias-shot-" + i, assetId, sourceStart: 0, sourceEnd: 2, salience: 1, storyOrder: i });
    }
    input.sources = sources; input.candidates = candidates;
    const packet = await prepare(); expect(() => compileEasyMusicMontageV1(packet, options())).toThrow(/REPEATED_PHYSICAL_SOURCE_WINDOW/);
  });
});
