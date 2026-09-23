import { mkdir, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { initializeStudioCreativeAssets } from "../../src/creative/studioAssets";
import {
  LOOK_PRESETS,
  TRANSITION_PRESETS,
  transitionRenderers,
  type LookPreset,
  type TransitionPreset,
} from "../../src/creative/corePack";
import { initializeWave2Registry } from "../../src/creative/wave2Registry";
import { createEmptyProject } from "../../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../../src/domain/types";
import {
  lookColorTerms,
  transitionBrightnessExpression,
  transitionOpacityExpression,
  transitionScaleExpression,
  transitionXExpression,
} from "../../src/render/creativeFilters";
import { renderProject } from "../../src/render/ffmpeg";
import {
  decodedSampleSignature,
  hashCanonical,
  type ArtifactIdentity,
  type CinematicDecodedMatrixInput,
  type DecodedMatrixObservation,
  type FileIdentity,
  type MatrixRegistryEntry,
} from "./cinematic-decoded-matrix-gate";
import {
  MATRIX_FPS,
  MATRIX_HEIGHT,
  MATRIX_WIDTH,
  buildDecodedSample,
  collectArtifactIdentity,
  collectFileIdentity,
  decodeMatrixFrames,
  type SampleRequest,
} from "./cinematic-decoded-matrix-io";

const LOOK_CLIP_FRAMES = 24;
const TRANSITION_CLIP_FRAMES = 72;
const SHARD_SIZE = 8;

export const appRoot = resolve(import.meta.dirname, "../..");
export const defaultEvidenceRoot = resolve(appRoot, ".rd/benchmarks/editkin-cinematic-decoded-matrix");
const ffmpegPath = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const sourcePath = resolve(appRoot, "public/demo-source.mp4");

interface ShardRender {
  baselinePath: string;
  candidatePath: string;
  entries: Array<LookPreset | TransitionPreset>;
  requests: SampleRequest[][];
}

function n(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

export async function fileIdentity(path: string): Promise<FileIdentity> {
  return collectFileIdentity(path, appRoot);
}

async function artifactIdentity(path: string): Promise<ArtifactIdentity> {
  return collectArtifactIdentity(path, appRoot, ffprobePath);
}

function baseClip(id: string, timelineStart: number, duration: number): TimelineClip {
  return {
    id,
    assetId: "matrix-source",
    trackId: "video-main",
    timelineStart,
    sourceStart: 2,
    duration,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR },
    keyframes: [],
  };
}

function projectFor(kind: "look" | "transition", entries: Array<LookPreset | TransitionPreset>, candidate: boolean): EditProject {
  const clipFrames = kind === "look" ? LOOK_CLIP_FRAMES : TRANSITION_CLIP_FRAMES;
  const project = createEmptyProject(`${kind}-${candidate ? "candidate" : "baseline"}`, {
    id: `${kind}-${candidate ? "candidate" : "baseline"}`,
    width: MATRIX_WIDTH,
    height: MATRIX_HEIGHT,
    fps: MATRIX_FPS,
  });
  project.assets.push({
    id: "matrix-source",
    name: "Decoded matrix source",
    kind: "video",
    uri: sourcePath,
    duration: 12,
    width: 960,
    height: 540,
  });
  if (kind === "transition") {
    project.tracks[0].clips.push(baseClip("transition-leading-guard", 0, TRANSITION_CLIP_FRAMES / MATRIX_FPS));
  }
  entries.forEach((entry, index) => {
    const duration = clipFrames / MATRIX_FPS;
    const timelineIndex = kind === "transition" ? index + 1 : index;
    const clip = baseClip(`${kind}-${entry.id}`, timelineIndex * duration, duration);
    if (candidate && kind === "look") clip.creative = { lookPresetId: entry.id, effectPresetIds: [] };
    if (candidate && kind === "transition") {
      const transition = entry as TransitionPreset;
      clip.creative = {
        effectPresetIds: [],
        transitionIn: { presetId: transition.id, duration: transition.defaultDuration },
        transitionOut: { presetId: transition.id, duration: transition.defaultDuration },
      };
    }
    project.tracks[0].clips.push(clip);
  });
  if (kind === "transition") {
    project.tracks[0].clips.push(baseClip("transition-trailing-guard", (entries.length + 1) * TRANSITION_CLIP_FRAMES / MATRIX_FPS, TRANSITION_CLIP_FRAMES / MATRIX_FPS));
  }
  return project;
}

function lookRequests(index: number): SampleRequest[] {
  return [4, 10, 16].map((localFrame) => ({ phase: "steady", localFrame, globalFrame: index * LOOK_CLIP_FRAMES + localFrame }));
}

function transitionRequests(entry: TransitionPreset, index: number): SampleRequest[] {
  const durationFrames = Math.max(4, Math.round(entry.defaultDuration * MATRIX_FPS));
  const offsets = [1, Math.max(2, Math.min(durationFrames - 2, Math.round(durationFrames / 2))), durationFrames - 1];
  const clipStart = (index + 1) * TRANSITION_CLIP_FRAMES;
  const outStart = TRANSITION_CLIP_FRAMES - durationFrames;
  return [
    ...offsets.map((localFrame) => ({ phase: "in" as const, localFrame, globalFrame: clipStart + localFrame })),
    ...offsets.map((localFrame) => ({ phase: "out" as const, localFrame, globalFrame: clipStart + outStart + localFrame })),
  ];
}

function resolvedTransitionParameters(entry: TransitionPreset): Record<string, number> {
  const output: Record<string, number> = {};
  const renderers = transitionRenderers(entry);
  if (renderers.includes("transition-fade")) output.fadeCurve = entry.parameters?.fadeCurve ?? 1;
  if (renderers.includes("transition-zoom")) output.zoomAmount = entry.parameters?.zoomAmount ?? 0.08;
  if (renderers.includes("transition-whip")) {
    output.travelPercent = entry.parameters?.travelPercent ?? 100;
    output.direction = entry.parameters?.direction ?? 1;
  }
  if (renderers.includes("transition-flash")) output.flashStrength = entry.parameters?.flashStrength ?? 0.55;
  return output;
}

function lookRegistryEntry(entry: LookPreset): MatrixRegistryEntry {
  const contract = { renderer: entry.renderer, color: entry.color };
  return { id: entry.id, renderer: entry.renderer, contract, contractFingerprint: hashCanonical(contract) };
}

function transitionRegistryEntry(entry: TransitionPreset): MatrixRegistryEntry {
  const contract = {
    renderers: transitionRenderers(entry),
    defaultDuration: entry.defaultDuration,
    parameters: resolvedTransitionParameters(entry),
  };
  return { id: entry.id, renderer: entry.renderer, contract, contractFingerprint: hashCanonical(contract) };
}

function expectedLookCompiler(entry: LookPreset): Record<string, unknown> {
  return {
    brightness: n(entry.color.brightness),
    contrast: n(entry.color.contrast),
    saturation: n(entry.color.saturation),
    hue: n(entry.color.hue),
  };
}

function expectedTransitionCompiler(entry: TransitionPreset): Record<string, unknown> {
  const renderers = transitionRenderers(entry);
  const parameters = resolvedTransitionParameters(entry);
  const duration = n(entry.defaultDuration);
  const clipDuration = n(TRANSITION_CLIP_FRAMES / MATRIX_FPS);
  const opacity = renderers.includes("transition-fade")
    ? `pow(min(1,max(0,T/${duration})),${n(parameters.fadeCurve)})*pow(min(1,max(0,(${clipDuration}-T)/${duration})),${n(parameters.fadeCurve)})`
    : "1";
  const scale = renderers.includes("transition-zoom")
    ? `1+${n(parameters.zoomAmount)}*max(0,1-t/${duration})*1+${n(parameters.zoomAmount)}*max(0,(t-${n(TRANSITION_CLIP_FRAMES / MATRIX_FPS - entry.defaultDuration)})/${duration})`
    : "1";
  const incomingX = n(-(parameters.direction ?? 1) * (parameters.travelPercent ?? 100) / 100 * MATRIX_WIDTH);
  const outgoingX = n((parameters.direction ?? 1) * (parameters.travelPercent ?? 100) / 100 * MATRIX_WIDTH);
  const x = renderers.includes("transition-whip")
    ? `${incomingX}*max(0,1-t/${duration})+${outgoingX}*max(0,(t-${n(TRANSITION_CLIP_FRAMES / MATRIX_FPS - entry.defaultDuration)})/${duration})`
    : "0";
  const brightness = renderers.includes("transition-flash")
    ? `${n(parameters.flashStrength)}*max(0,1-t/${duration})+${n(parameters.flashStrength)}*max(0,(t-${n(TRANSITION_CLIP_FRAMES / MATRIX_FPS - entry.defaultDuration)})/${duration})`
    : "0";
  return { opacity, scale, x, brightness };
}

function actualLookCompiler(entry: LookPreset): Record<string, unknown> {
  const clip = baseClip(`compiler-${entry.id}`, 0, LOOK_CLIP_FRAMES / MATRIX_FPS);
  clip.creative = { lookPresetId: entry.id, effectPresetIds: [] };
  return lookColorTerms(clip);
}

function actualTransitionCompiler(entry: TransitionPreset): Record<string, unknown> {
  const clip = baseClip(`compiler-${entry.id}`, 0, TRANSITION_CLIP_FRAMES / MATRIX_FPS);
  clip.creative = {
    effectPresetIds: [],
    transitionIn: { presetId: entry.id, duration: entry.defaultDuration },
    transitionOut: { presetId: entry.id, duration: entry.defaultDuration },
  };
  return {
    opacity: transitionOpacityExpression(clip),
    scale: transitionScaleExpression(clip),
    x: transitionXExpression(clip, MATRIX_WIDTH),
    brightness: transitionBrightnessExpression(clip),
  };
}

async function renderShard(
  evidenceRoot: string,
  kind: "look" | "transition",
  shardIndex: number,
  entries: Array<LookPreset | TransitionPreset>,
): Promise<ShardRender> {
  const shardRoot = resolve(evidenceRoot, `${kind}-shard-${String(shardIndex + 1).padStart(2, "0")}`);
  await mkdir(shardRoot, { recursive: true });
  const baselinePath = resolve(shardRoot, "baseline.mp4");
  const candidatePath = resolve(shardRoot, "candidate.mp4");
  const options = { ffmpegPath, ffprobePath, preferGpu: false, timeoutMs: 180_000 };
  await renderProject(projectFor(kind, entries, false), baselinePath, options);
  await renderProject(projectFor(kind, entries, true), candidatePath, options);
  const requests = entries.map((entry, index) => kind === "look" ? lookRequests(index) : transitionRequests(entry as TransitionPreset, index));
  return { baselinePath, candidatePath, entries, requests };
}

async function observationsForShard(
  kind: "look" | "transition",
  shard: ShardRender,
  baselineArtifact: ArtifactIdentity,
  candidateArtifact: ArtifactIdentity,
  source: FileIdentity,
  registryById: Map<string, MatrixRegistryEntry>,
): Promise<DecodedMatrixObservation[]> {
  const indices = shard.requests.flat().map((request) => request.globalFrame);
  const baselineFrames = await decodeMatrixFrames(shard.baselinePath, indices, ffmpegPath);
  const candidateFrames = await decodeMatrixFrames(shard.candidatePath, indices, ffmpegPath);
  return shard.entries.map((entry, index) => {
    const samples = shard.requests[index].map((request) => {
      const baseline = baselineFrames.get(request.globalFrame);
      const candidate = candidateFrames.get(request.globalFrame);
      if (!baseline || !candidate) throw new Error(`missing decoded frame ${request.globalFrame} for ${entry.id}`);
      return buildDecodedSample(request, baseline, candidate);
    });
    const expectedCompiler = kind === "look" ? expectedLookCompiler(entry as LookPreset) : expectedTransitionCompiler(entry as TransitionPreset);
    const actualCompiler = kind === "look" ? actualLookCompiler(entry as LookPreset) : actualTransitionCompiler(entry as TransitionPreset);
    return {
      kind,
      id: entry.id,
      registryFingerprint: registryById.get(entry.id)?.contractFingerprint ?? "",
      expectedCompiler,
      actualCompiler,
      expectedCompilerFingerprint: hashCanonical(expectedCompiler),
      actualCompilerFingerprint: hashCanonical(actualCompiler),
      sourcePath: source.path,
      sourceBytes: source.bytes,
      sourceSha256: source.sha256,
      baselineArtifact: { path: baselineArtifact.path, sha256: baselineArtifact.sha256 },
      candidateArtifact: { path: candidateArtifact.path, sha256: candidateArtifact.sha256 },
      samples,
      decodedSignature: decodedSampleSignature(samples),
    };
  });
}

export async function collectCinematicDecodedMatrixEvidence(evidenceRoot = defaultEvidenceRoot): Promise<CinematicDecodedMatrixInput> {
  initializeStudioCreativeAssets();
  initializeWave2Registry();
  const source = await fileIdentity(sourcePath);
  const registry = {
    looks: LOOK_PRESETS.map(lookRegistryEntry),
    transitions: TRANSITION_PRESETS.map(transitionRegistryEntry),
  };
  const lookRegistry = new Map(registry.looks.map((entry) => [entry.id, entry]));
  const transitionRegistry = new Map(registry.transitions.map((entry) => [entry.id, entry]));
  const artifacts: ArtifactIdentity[] = [];
  const observations: DecodedMatrixObservation[] = [];
  let determinism: CinematicDecodedMatrixInput["determinism"] | undefined;

  for (const [shardIndex, entries] of chunks(LOOK_PRESETS, SHARD_SIZE).entries()) {
    const shard = await renderShard(evidenceRoot, "look", shardIndex, entries);
    const baseline = await artifactIdentity(shard.baselinePath);
    const candidate = await artifactIdentity(shard.candidatePath);
    artifacts.push(baseline, candidate);
    observations.push(...await observationsForShard("look", shard, baseline, candidate, source, lookRegistry));
    if (shardIndex === 0) {
      const repeatPath = resolve(evidenceRoot, "look-shard-01", "baseline-repeat.mp4");
      await renderProject(projectFor("look", entries, false), repeatPath, { ffmpegPath, ffprobePath, preferGpu: false, timeoutMs: 180_000 });
      const repeat = await artifactIdentity(repeatPath);
      artifacts.push(repeat);
      const requests = shard.requests.flat().map((request) => request.globalFrame);
      const baselineFrames = await decodeMatrixFrames(shard.baselinePath, requests, ffmpegPath);
      const repeatFrames = await decodeMatrixFrames(repeatPath, requests, ffmpegPath);
      const decodedSignaturesEqual = requests.every((frame) => baselineFrames.get(frame)?.equals(repeatFrames.get(frame) ?? Buffer.alloc(0)));
      determinism = {
        baselinePath: baseline.path,
        repeatPath: repeat.path,
        baselineSha256: baseline.sha256,
        repeatSha256: repeat.sha256,
        decodedSignaturesEqual,
      };
    }
  }

  for (const [shardIndex, entries] of chunks(TRANSITION_PRESETS, SHARD_SIZE).entries()) {
    const shard = await renderShard(evidenceRoot, "transition", shardIndex, entries);
    const baseline = await artifactIdentity(shard.baselinePath);
    const candidate = await artifactIdentity(shard.candidatePath);
    artifacts.push(baseline, candidate);
    observations.push(...await observationsForShard("transition", shard, baseline, candidate, source, transitionRegistry));
  }
  if (!determinism) throw new Error("look baseline determinism fixture was not created");

  const registrySourcePaths = [
    resolve(appRoot, "src/creative/haoCorePack.json"),
    resolve(appRoot, "src/creative/corePack.ts"),
    resolve(appRoot, "src/creative/studioAssets.ts"),
    resolve(appRoot, "src/creative/wave2Registry.ts"),
    resolve(appRoot, "../../community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json"),
  ];
  const rendererSourcePaths = [
    resolve(appRoot, "src/render/creativeFilters.ts"),
    resolve(appRoot, "src/render/ffmpegComposite.ts"),
    resolve(appRoot, "src/render/ffmpeg.ts"),
  ];
  const evaluatorSourcePaths = [
    resolve(appRoot, "scripts/cinematic-decoded-matrix-gate.ts"),
    resolve(appRoot, "scripts/lib/cinematic-decoded-matrix-gate.ts"),
    resolve(appRoot, "scripts/lib/cinematic-decoded-matrix-io.ts"),
    resolve(appRoot, "scripts/lib/cinematic-decoded-matrix-runtime.ts"),
  ];
  const [registrySources, rendererSources, evaluatorSources, runtimes] = await Promise.all([
    Promise.all(registrySourcePaths.map(fileIdentity)),
    Promise.all(rendererSourcePaths.map(fileIdentity)),
    Promise.all(evaluatorSourcePaths.map(fileIdentity)),
    Promise.all([ffmpegPath, ffprobePath].map(fileIdentity)),
  ]);
  return {
    schema: "editkin.cinematic-decoded-matrix-evidence/v1",
    source,
    registrySources,
    rendererSources,
    evaluatorSources,
    runtimes,
    artifacts,
    registry,
    observations,
    determinism,
  };
}

export async function ensureEvidenceRoot(path = defaultEvidenceRoot): Promise<void> {
  const resolved = resolve(path);
  const expectedParent = resolve(appRoot, ".rd/benchmarks");
  if (resolved !== defaultEvidenceRoot || relative(expectedParent, resolved).startsWith("..")) {
    throw new Error(`refusing unexpected cinematic evidence root: ${resolved}`);
  }
  await mkdir(resolved, { recursive: true });
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`cinematic evidence root is not a directory: ${resolved}`);
}

export async function resetEvidenceRoot(path = defaultEvidenceRoot): Promise<void> {
  const resolved = resolve(path);
  const expectedParent = resolve(appRoot, ".rd/benchmarks");
  if (resolved !== defaultEvidenceRoot || relative(expectedParent, resolved).startsWith("..")) {
    throw new Error(`refusing unexpected cinematic evidence root reset: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
  await ensureEvidenceRoot(resolved);
}
