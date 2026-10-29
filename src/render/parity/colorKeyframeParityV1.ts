import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPhoneProjectV1 } from "../../application/phoneProjectV1";
import { animatedClipState, createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipKeyframe, type ColorAdjustments, type EditProject, type KeyframeEasing } from "../../domain/types";
import { renderComposite } from "../ffmpegComposite";
import { buildRenderPlan } from "../planner";
import { PARITY_CANVAS_V1, paritySamplePointsV1 } from "./blendParityFixturesV1";
import { PARITY_TOLERANCE_V1, type ParityRgb8V1 } from "./blendParityHarnessV1";

const run = promisify(execFile);

/**
 * Colour keyframe parity (AREA_B C1, 2026-10-23). The preview evaluates a keyframed clip's colour with
 * animatedClipState at each frame and grades the frame with that static colour. The export is in parity when every
 * frame of the animated export equals the export of a clip graded with the preview-evaluated colour of that frame.
 * Both sides run Editkin's real renderComposite (FFV1, decoded RGB), so only the animated chain is measured; the
 * static grade's own preview maths (CSS/GLSL vs FFmpeg) is a separate gap (C1 static) and is not measured here.
 *
 * Every keyframed clip's export also carries the eq/hue stage (a YUV round trip, even at neutral values) that a clip
 * without keyframes skips; that stage predates this fix and applies to brightness/contrast keyframes alike. So the
 * gating reference (`maxDelta`) is a keyframed clip whose colour is the evaluated colour at every frame (same eq
 * stage, static primary chain): it isolates the per-frame primary chain. `staticDelta` reports the comparison with a
 * plain clip without keyframes (includes the eq round trip). `flatDelta` is the pre-fix behaviour (exposure,
 * temperature, tint and tone rendered from the static clip colour) against the gating reference.
 */
export interface ColorKeyframeParityFixtureV1 {
  id: string;
  colour: "rec709" | "aces2-phone";
  duration: number;
  keyframes: Array<{ time: number; color: Partial<ColorAdjustments>; easing: KeyframeEasing }>;
  /** Frames compared (clip-local frame numbers). */
  frames: number[];
}

export const COLOR_KEYFRAME_PARITY_FIXTURES_V1: readonly ColorKeyframeParityFixtureV1[] = [
  { id: "rec709/exposure-temperature", colour: "rec709", duration: 1,
    keyframes: [{ time: 0, color: { exposure: 0, temperature: -.6 }, easing: "linear" }, { time: .6, color: { exposure: 1.5, temperature: .8 }, easing: "ease_in_out" },
      { time: .9, color: { exposure: 1.5, temperature: .8 }, easing: "linear" }],
    frames: [0, 1, 4, 9, 13, 17, 18, 19, 23, 27, 29] },
  { id: "rec709/tone-tint-hold", colour: "rec709", duration: 1,
    keyframes: [{ time: 0, color: { shadows: 0, highlights: 0, blacks: 0, whites: 0, pivot: .5, tint: 0 }, easing: "ease_out" },
      { time: .5, color: { shadows: .5, highlights: -.4, blacks: .3, whites: -.5, pivot: .35, tint: -.7 }, easing: "hold" },
      { time: .8, color: { shadows: -.3, highlights: .4, blacks: 0, whites: 0, pivot: .6, tint: .5 }, easing: "linear" }],
    frames: [0, 2, 7, 12, 14, 15, 16, 20, 23, 24, 25, 29] },
  { id: "rec709/all-fields-with-eq", colour: "rec709", duration: 1,
    keyframes: [{ time: .2, color: { exposure: -.8, brightness: .05, contrast: 1.2, saturation: .7, temperature: .4, shadows: .2 }, easing: "linear" },
      { time: .8, color: { exposure: .7, brightness: -.05, contrast: .9, saturation: 1.3, temperature: -.4, shadows: -.2, whites: -.3 }, easing: "spring_soft" }],
    frames: [0, 5, 6, 10, 15, 20, 24, 25, 29] },
  { id: "aces2-phone/exposure-tone", colour: "aces2-phone", duration: 1,
    keyframes: [{ time: 0, color: { exposure: 0, highlights: 0 }, easing: "linear" }, { time: .7, color: { exposure: .9, highlights: -.5, tint: .3 }, easing: "ease_in" }],
    frames: [0, 3, 10, 17, 21, 25, 29] },
];

export interface ColorKeyframeParityFrameV1 { frame: number; maxDelta: number; staticDelta: number; flatDelta: number; color: ColorAdjustments; worst?: { label: string; expected: ParityRgb8V1; actual: ParityRgb8V1 } }
export interface ColorKeyframeParityResultV1 {
  fixture: string; colour: ColorKeyframeParityFixtureV1["colour"]; tolerance: number; maxDelta: number; maxStaticDelta: number; maxFlatDelta: number;
  status: "pass" | "fail" | "declined"; reason?: string; frames: ColorKeyframeParityFrameV1[];
}

function clipColor(base: ColorAdjustments, patch: Partial<ColorAdjustments>): ColorAdjustments { return { ...base, ...patch }; }

/** One full-canvas image clip: the fixture's keyframes, or `color` held static (`keyframed`: as one keyframe at 0). */
export function colorKeyframeParityProjectV1(fixture: ColorKeyframeParityFixtureV1, imagePath: string,
  variant: { keyframes: true } | { color: ColorAdjustments; keyframed: boolean }): EditProject {
  const { width, height, fps } = PARITY_CANVAS_V1;
  const project = (fixture.colour === "aces2-phone" ? createPhoneProjectV1 : createEmptyProject)("Colour keyframe parity", { id: "colour-keyframe-parity", width, height, fps });
  if (fixture.colour === "aces2-phone") project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  project.assets.push({ id: "image", name: "image", uri: imagePath, kind: "image", duration: 5, width, height });
  const keyframes: ClipKeyframe[] = "keyframes" in variant ? fixture.keyframes.map((key, index) => ({ id: `k${index}`, time: key.time, easing: key.easing,
    transform: { ...DEFAULT_TRANSFORM }, color: clipColor(DEFAULT_COLOR, key.color) }))
    : variant.keyframed ? [{ id: "k0", time: 0, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...variant.color } }] : [];
  project.tracks[0].clips.push({ id: "clip", assetId: "image", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: fixture.duration,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: "color" in variant ? { ...variant.color } : { ...DEFAULT_COLOR }, keyframes });
  return project;
}

export interface ColorKeyframeParityOptionsV1 { ffmpegPath: string; ffprobePath: string; colorRoot?: string; workDirectory: string; timeoutMs?: number }

async function renderFrames(project: EditProject, output: string, options: ColorKeyframeParityOptionsV1, colorRoot: string | undefined): Promise<ParityRgb8V1[][]> {
  const { width, height } = PARITY_CANVAS_V1;
  await renderComposite(options.ffmpegPath, options.ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", options.timeoutMs ?? 180_000, undefined, colorRoot);
  const { stdout } = await run(options.ffmpegPath, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const size = width * height * 3, frames: ParityRgb8V1[][] = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) {
    frames.push(paritySamplePointsV1().map(({ x, y }) => { const i = offset + (y * width + x) * 3; return [stdout[i], stdout[i + 1], stdout[i + 2]] as const; }));
  }
  return frames;
}

const delta = (a: readonly ParityRgb8V1[], b: readonly ParityRgb8V1[]) => {
  let max = 0, worst = 0;
  a.forEach((sample, index) => { const d = Math.max(...sample.map((value, channel) => Math.abs(value - b[index][channel]))); if (d > max) { max = d; worst = index; } });
  return { max, worst };
};

export async function runColorKeyframeParityV1(fixture: ColorKeyframeParityFixtureV1, imagePath: string, options: ColorKeyframeParityOptionsV1): Promise<ColorKeyframeParityResultV1> {
  const tolerance = PARITY_TOLERANCE_V1[fixture.colour];
  if (fixture.colour === "aces2-phone" && !options.colorRoot) return { fixture: fixture.id, colour: fixture.colour, tolerance, maxDelta: 0, maxStaticDelta: 0, maxFlatDelta: 0, status: "declined", reason: "ACES 2 colour resources not provided", frames: [] };
  const colorRoot = fixture.colour === "aces2-phone" ? options.colorRoot : undefined;
  const directory = join(options.workDirectory, fixture.id.replace(/[^a-z0-9]+/gi, "-"));
  await mkdir(directory, { recursive: true });
  const animatedProject = colorKeyframeParityProjectV1(fixture, imagePath, { keyframes: true });
  const animated = await renderFrames(animatedProject, join(directory, "animated.mkv"), options, colorRoot);
  // Pre-fix behaviour: the static clip colour for every non-eq field (eq fields animated as before).
  const clip = animatedProject.tracks[0].clips[0];
  const flatProject = structuredClone(animatedProject);
  for (const key of flatProject.tracks[0].clips[0].keyframes) for (const field of ["exposure", "temperature", "tint", "pivot", "shadows", "highlights", "blacks", "whites"] as const) key.color[field] = clip.color[field];
  const flat = await renderFrames(flatProject, join(directory, "flat.mkv"), options, colorRoot);
  const cache = new Map<string, { keyframed: ParityRgb8V1[]; plain: ParityRgb8V1[] }>();
  const frames: ColorKeyframeParityFrameV1[] = [];
  for (const frame of fixture.frames) {
    const color = animatedClipState(clip, frame / PARITY_CANVAS_V1.fps, PARITY_CANVAS_V1.fps).color;
    const key = JSON.stringify(color);
    let reference = cache.get(key);
    if (!reference) {
      const index = cache.size;
      reference = {
        keyframed: (await renderFrames(colorKeyframeParityProjectV1(fixture, imagePath, { color, keyframed: true }), join(directory, `keyframed-${index}.mkv`), options, colorRoot))[0],
        plain: (await renderFrames(colorKeyframeParityProjectV1(fixture, imagePath, { color, keyframed: false }), join(directory, `static-${index}.mkv`), options, colorRoot))[0],
      };
      cache.set(key, reference);
    }
    const actual = animated[frame];
    if (!actual) throw new Error(`animated export is missing frame ${frame}`);
    const measured = delta(actual, reference.keyframed), plain = delta(actual, reference.plain), old = delta(flat[frame], reference.keyframed);
    const label = paritySamplePointsV1()[measured.worst].label;
    frames.push({ frame, maxDelta: measured.max, staticDelta: plain.max, flatDelta: old.max, color,
      ...(measured.max ? { worst: { label, expected: reference.keyframed[measured.worst], actual: actual[measured.worst] } } : {}) });
  }
  const maxDelta = Math.max(...frames.map(frame => frame.maxDelta)), maxFlatDelta = Math.max(...frames.map(frame => frame.flatDelta));
  const maxStaticDelta = Math.max(...frames.map(frame => frame.staticDelta));
  return { fixture: fixture.id, colour: fixture.colour, tolerance, maxDelta, maxStaticDelta, maxFlatDelta, status: maxDelta <= tolerance ? "pass" : "fail", frames };
}
