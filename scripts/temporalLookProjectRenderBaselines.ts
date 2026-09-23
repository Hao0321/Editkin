import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import { DEFAULT_PARTICLE_SIMULATION, type EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";

export interface TemporalLookRuntimeBase {
  ffmpegPath: string;
  nativeCorePath: string;
  gpuCompositorPath: string;
  pluginRoots: string[];
  fontRoot: string;
  timeoutMs: number;
}

export interface TemporalLookBaselineOptions {
  temporary: string;
  reportPath: string;
  compositor: string;
  runtimeBase: TemporalLookRuntimeBase;
  baseline: boolean;
  overlayBaseline: boolean;
  partialOverlayBaseline: boolean;
  multiOverlayBaseline: boolean;
  multiAdjustmentBaseline: boolean;
  particleLookBaseline: boolean;
  particleMultiAdjustmentBaseline: boolean;
  particleOverlayBaseline: boolean;
  particleOverlayMultiAdjustmentBaseline: boolean;
  particlePartialOverlayBaseline: boolean;
  particlePartialOverlayMultiAdjustmentBaseline: boolean;
  particleAnimatedOverlayBaseline: boolean;
  particleAnimatedOverlayTwoKeyframeBaseline: boolean;
  particleAnimatedOverlayMultiAdjustmentBaseline: boolean;
}

const root = resolve(import.meta.dirname, "..");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export function projectWithTemporalLook({ typography = true, adjustment = true, overlay = false } = {}): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30; project.captions = []; project.motionGraphics = [];
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  const base = project.tracks[0].clips[0]; base.duration = .5; base.transform = { x: -180, y: 0, scale: .65, rotation: -6, opacity: 1 };
  base.keyframes = [{ id: "motion", time: 14 / 30, transform: { x: 180, y: 0, scale: .65, rotation: 6, opacity: 1 }, color: { ...base.color }, easing: "linear" }];
  const motion = createTransformMotionBlurInstance(); motion.parameters.shutter_angle = 360; base.creative = { effectPresetIds: [], nativeEffectInstances: [motion] };
  if (overlay) {
    const overlayAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay" };
    project.assets.push(overlayAsset);
    const overlayClip = { ...structuredClone(base), id: "clip-overlay", trackId: "track-overlay", assetId: overlayAsset.id, sourceStart: .2, keyframes: [], transform: { x: 285, y: 145, scale: .32, rotation: 0, opacity: 1 }, creative: { effectPresetIds: [], nativeEffectInstances: [] } };
    project.tracks.push({ id: "track-overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [overlayClip] });
  }
  if (typography) {
    project.captions.push({ id: "caption-single-colour", text: "字幕保持單色", start: 3 / 30, duration: 9 / 30 });
    project.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "title-card", name: "Title", kind: "card", text: "關鍵重點", timelineStart: 4 / 30, duration: 8 / 30,
      x: .08, y: .09, width: .48, fontSize: 54, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 0, outlineWidth: 3, shadowDepth: 3, cornerRadius: 18,
      textColor: "#FFFFFFFF", backgroundColor: "#10151FEE", accentColor: "#A8FF3EFF", animation: "slide_up", offsetX: 0, offsetY: 0,
    });
  }
  if (adjustment) {
    const grade = structuredClone(base); grade.id = "adjustment-grade"; grade.trackId = "track-adjustment"; grade.timelineStart = 3 / 30; grade.duration = 9 / 30; grade.sourceStart = 0; grade.keyframes = [];
    grade.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    grade.color = { ...grade.color, brightness: .04, contrast: 1.15, saturation: .8, exposure: .35, temperature: .2, tint: -.1, shadows: .15, highlights: -.1, blacks: .08, whites: -.04 };
    grade.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    project.tracks.push({ id: "track-adjustment", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [grade] });
  }
  return project;
}

export function addSecondExactOverlay(project: EditProject): EditProject {
  const firstTrack = project.tracks.find((track) => track.id === "track-overlay");
  const first = firstTrack?.clips[0];
  if (!first) throw new Error("second-overlay fixture requires the first overlay");
  const asset = { ...structuredClone(project.assets.find((candidate) => candidate.id === first.assetId)!), id: "asset-overlay-two" };
  project.assets.push(asset);
  const clip = {
    ...structuredClone(first), id: "clip-overlay-two", trackId: "track-overlay-two", assetId: asset.id, sourceStart: .1,
    transform: { x: -285, y: 145, scale: .28, rotation: 0, opacity: .9 },
  };
  const track = { id: "track-overlay-two", name: "Overlay 2", kind: "video", locked: false, muted: false, clips: [clip] } as EditProject["tracks"][number];
  const adjustmentIndex = project.tracks.findIndex((candidate) => candidate.clips.some((candidateClip) => candidateClip.layer?.role === "adjustment"));
  if (adjustmentIndex < 0) project.tracks.push(track);
  else project.tracks.splice(adjustmentIndex, 0, track);
  return project;
}

export function addSecondAdjustment(project: EditProject): EditProject {
  const firstTrack = project.tracks.find((track) => track.id === "track-adjustment");
  const first = firstTrack?.clips[0];
  if (!first) throw new Error("second-adjustment fixture requires the first adjustment");
  const clip = {
    ...structuredClone(first), id: "adjustment-finish", trackId: "track-adjustment-finish",
    timelineStart: 5 / 30, duration: 6 / 30,
    color: { ...first.color, brightness: -.02, contrast: 1.04, saturation: 1.12, exposure: -.12, temperature: -.08, tint: .06 },
  };
  project.tracks.push({
    id: "track-adjustment-finish", name: "Adjustment Finish", kind: "video", locked: false, muted: false, clips: [clip],
  });
  return project;
}

export function addParticleLook(project: EditProject): EditProject {
  project.particleSimulation = {
    ...structuredClone(DEFAULT_PARTICLE_SIMULATION),
    ratePerSecond: 72,
    maxParticles: 48,
    timeline: { start: 4 / 30, duration: 6 / 30 },
    color: [.66, 1, .24, .92],
  };
  return project;
}

export function addAnimatedOverlay(project: EditProject): EditProject {
  const overlay = project.tracks.find((track) => track.id === "track-overlay")?.clips[0];
  if (!overlay) throw new Error("animated-overlay fixture requires the first overlay");
  overlay.keyframes = [{
    id: "overlay-transform-motion",
    time: 9 / 30,
    transform: { x: -250, y: 105, scale: .4, rotation: -8, opacity: .82 },
    color: { ...overlay.color },
    easing: "ease_in_out",
  }];
  return project;
}

export function addTwoKeyframeAnimatedOverlay(project: EditProject): EditProject {
  addAnimatedOverlay(project);
  const overlay = project.tracks.find((track) => track.id === "track-overlay")?.clips[0];
  if (!overlay) throw new Error("two-keyframe animated-overlay fixture requires the first overlay");
  overlay.keyframes.push({
    id: "overlay-transform-settle",
    time: 13 / 30,
    transform: { x: 165, y: 72, scale: .3, rotation: 5, opacity: .94 },
    color: { ...overlay.color },
    easing: "ease_out",
  });
  return project;
}

export async function extractFrames(ffmpeg: string, input: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vsync", "0", "-start_number", "0", join(outputDirectory, "frame-%08d.png")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr)));
  });
}

export function changedStats(left: Buffer, right: Buffer, prefix: "typography" | "adjustment" | "overlay" | "particle") {
  const a = PNG.sync.read(left); const b = PNG.sync.read(right); let changed = 0; let high = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) { let delta = 0; for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]); if (delta > 8) changed += 1; if (delta > 32) high += 1; }
  return prefix === "typography" ? { typographyChangedPixels: changed, typographyHighDeltaPixels: high }
    : prefix === "adjustment" ? { adjustmentChangedPixels: changed, adjustmentHighDeltaPixels: high }
      : prefix === "particle" ? { particleChangedPixels: changed, particleHighDeltaPixels: high }
        : { overlayChangedPixels: changed, overlayHighDeltaPixels: high };
}

export async function materializeCase(project: EditProject, workspace: string, runtimeBase: { ffmpegPath: string; nativeCorePath: string; gpuCompositorPath: string; pluginRoots: string[]; fontRoot: string; timeoutMs: number }) {
  const plan = buildRenderPlan(project, (uri) => uri); const receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace }); const clip = receipt?.clips[0];
  const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip");
  if (!clip?.gpu || !intermediate || intermediate.kind !== "clip") throw new Error("temporal look materialization missing");
  return { project, plan, receipt: receipt!, clip, intermediate };
}


