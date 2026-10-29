import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { encodeProjectBytes } from "../application/projectCodec";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { timelineTransitionSchemaV1 } from "../domain/timelineTransitionV1";
import { pairFixtureV1 } from "../domain/timelineTransitionV1.fixture";
import { DEFAULT_COLOR, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { editkinModuleRegistry } from "../modules/moduleRegistry";
import { editkinModuleMetadataRegistryV2 } from "../modules/moduleMetadataRuntimeV2";
import { canonicalJson } from "../shared/canonicalJson";
import { buildEngineRenderGraph } from "./engineGraph";
import { renderComposite } from "./ffmpegComposite";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { buildRenderPlan } from "./planner";
import { timelineTransitionCompositeGraphV1 } from "./timelineTransitionCompositeV1";
import { timelineTransitionLinearShaderV1, timelineTransitionMixGraphV1 } from "./timelineTransitionMixV1";

/**
 * Motion Library Phase 3 additive identity. Every value below was captured from the source BEFORE the matte kernel,
 * the clip/transition `motionLibrary` fields and the motion library commands existed (EDITKIN_P3C_CAPTURE=1 run on
 * 2026-10-22, golden file beside this test). A project without the new fields must still save, validate, build the
 * same render graphs and decode to the same pixels.
 *
 * Intended update (2026-10-22, render fixes, approved): the pair16 layer stack moved to native filters, so
 * compositeGraph.dissolve, compositeGraph.dip and pixels.aces2.dissolveOverlay were re-recorded (that fixture: at most
 * 1/65535 in 166 of 49,152 pixels; the other pixel fixtures are unchanged). Nothing else was re-captured.
 */
const GOLDEN = resolve("src/render/motionLibraryAdditiveIdentity.golden.json");
const CAPTURE = process.env.EDITKIN_P3C_CAPTURE === "1";
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Wall-clock stamps are not content; every other byte is. */
const stable = (bytes: Uint8Array | string) => (typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")).replace(ISO, "1970-01-01T00:00:00.000Z");

function pairProject(kernel: "dissolve" | "dip"): EditProject {
  const { project, transition } = pairFixtureV1();
  project.timelineTransitions = [{ ...transition, kernel }];
  return validateProject(project);
}
function nativeFixture(): EditProject {
  const { project, transition } = pairFixtureV1();
  project.width = 960; project.height = 540;
  project.assets[0].uri = "C:/fixtures/original-pair-source.mp4";
  project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-13T00:00:00.000Z", proxyUri: "C:/fixtures/nominal-proxy.mp4", proxyWidth: 480, proxyHeight: 270 };
  project.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
  project.timelineTransitions = [transition];
  return project;
}
function richProject(): EditProject {
  let project = createEmptyProject("Identity", { id: "identity-project", width: 1080, height: 1920, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 8, width: 1080, height: 1920 } });
  project = applyCommand(project, { type: "import_asset", asset: { id: "overlay", name: "Overlay", kind: "video", uri: "overlay.mov", duration: 3, width: 1080, height: 1920, alphaMode: "straight" } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "a", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "b", assetId: "footage", trackId: "video-main", timelineStart: 4, sourceStart: 4, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  project = applyCommand(project, { type: "add_track", track: { id: "overlay-track", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "o", assetId: "overlay", trackId: "overlay-track", timelineStart: 1, sourceStart: 0, duration: 3,
    volume: 1, transform: { ...DEFAULT_TRANSFORM, scale: .8 }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  project = applyCommand(project, { type: "add_caption", caption: { id: "cap", text: "字幕", start: 0, duration: 2 } });
  project = applyCommand(project, { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "cut", trackId: "video-main",
    fromClipId: "a", toClipId: "b", beforeFrames: 6, afterFrames: 6, kernel: "dissolve" } });
  return project;
}

// ---------------------------------------------------------------- real renders (pixels)
const W = 64, H = 32, FPS = 30, SOURCE_FRAMES = 40, FRAMES = 24;
let root: string;
beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? process.env.TMP ?? "."), `p3c-identity-${process.pid}`);
  await mkdir(root, { recursive: true });
  for (const side of [0, 1, 2]) {
    const raw = Buffer.alloc(SOURCE_FRAMES * W * H * 8);
    for (let f = 0; f < SOURCE_FRAMES; f += 1) for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < W * H; i += 1) {
      const x = i % W, y = Math.floor(i / W);
      const value = plane === 3 ? (side === 2 ? (x * 1031 + y * 2003) % 65536 : 65535) : 9000 + side * 15000 + f * 211 + plane * 3001 + x * 97 + y * 13;
      raw.writeUInt16LE(value % 65536, 2 * ((f * 4 + plane) * W * H + i));
    }
    await writeFile(join(root, `${side}.raw`), raw);
    await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${W}x${H}`, "-framerate", String(FPS),
      "-i", join(root, `${side}.raw`), "-frames:v", String(SOURCE_FRAMES), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrap16le", "-color_range", "pc", join(root, `${side}.mkv`)], 4096, 30_000);
  }
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function renderFixture(mode: "rec709" | "aces2", kernel: "dissolve" | "dip" | undefined, overlay: boolean): EditProject {
  const p = createPhoneProjectV1("Identity render", { id: "identity-render", width: W, height: H, fps: FPS });
  p.colorManagement!.mode = mode;
  p.assets = [0, 1, 2].map(side => ({ id: String(side), name: `Source ${side}`, uri: join(root, `${side}.mkv`), kind: "video" as const, duration: SOURCE_FRAMES / FPS,
    width: W, height: H, alphaMode: side === 2 ? "straight" as const : "opaque" as const, color: { interpretation: mode === "aces2" ? "acescct" as const : "rec709" as const, range: "pc" as const } }));
  p.tracks[0].clips = [0, 1].map(side => ({ id: `clip${side}`, assetId: String(side), trackId: p.tracks[0].id, timelineStart: side * 12 / FPS, sourceStart: (12 + side * 12) / FPS,
    duration: 12 / FPS, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }));
  if (overlay) p.tracks.push({ id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [{ id: "over", assetId: "2", trackId: "overlay",
    timelineStart: 4 / FPS, sourceStart: 0, duration: 16 / FPS, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
  if (kernel) p.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "cut", trackId: p.tracks[0].id, fromClipId: "clip0", toClipId: "clip1", beforeFrames: 4, afterFrames: 4, kernel }];
  return validateProject(p);
}
async function renderPixels(project: EditProject, name: string): Promise<string> {
  const output = join(root, `${name}.mkv`);
  await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 120_000, undefined, resolve("public/color/aces2"), undefined, undefined, true);
  const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-i", output, "-map", "0:v:0", "-frames:v", String(FRAMES), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"],
    FRAMES * W * H * 8, 30_000)).stdout;
  expect(bytes.length).toBe(FRAMES * W * H * 8);
  return sha(bytes);
}

async function compute(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  // Save / validate.
  const projects: Record<string, () => EditProject> = { dissolve: () => pairProject("dissolve"), dip: () => pairProject("dip"), demo: () => createDemoProject(), rich: () => richProject() };
  for (const [name, make] of Object.entries(projects)) {
    values[`save.${name}`] = sha(stable(encodeProjectBytes(make())));
    values[`validate.${name}`] = sha(stable(canonicalJson(validateProject(make()))));
    values[`plan.${name}`] = sha(stable(canonicalJson(buildRenderPlan(make(), uri => uri))));
  }
  const commands = [
    { type: "add_clip", clip: richProject().tracks[0].clips[0] },
    { type: "set_timeline_transition", transition: richProject().timelineTransitions![0] },
    { type: "import_asset", asset: richProject().assets[1] },
    { type: "batch", commands: [{ type: "delete_timeline_transition", transitionId: "cut" }, { type: "rename_project", name: "x" }] },
  ];
  values["commandSchema"] = sha(commands.map(command => canonicalJson(editorCommandSchema.parse(command))));
  values["transitionSchema"] = sha(["dissolve", "dip"].map(kernel => canonicalJson(timelineTransitionSchemaV1.parse({ ...pairFixtureV1().transition, kernel }))));
  // Render graphs.
  for (const kernel of ["dissolve", "dip"] as const) for (const space of ["linear", "acescct", "rec709_display"] as const) {
    values[`mixGraph.${kernel}.${space}`] = sha(timelineTransitionMixGraphV1("a", "b", "out", { startFrame: 48, durationFrames: 24 }, kernel, space));
  }
  for (const kernel of ["dissolve", "dip"] as const) {
    const project = pairProject(kernel), plan = buildRenderPlan(project, uri => uri);
    const clips = project.tracks.flatMap(track => track.clips);
    values[`compositeGraph.${kernel}`] = sha(timelineTransitionCompositeGraphV1(project, plan, clips, (clip, label) => [`[stub${clip.id.replace(/[^a-z0-9]/gi, "")}]null[${label}]`],
      (clip, input, output) => [`[${input}]null[${output}]`]));
    values[`engineGraph.${kernel}`] = sha(buildEngineRenderGraph(project, { nativeTimelineTransitionVersion: 1 }));
  }
  values["engineGraph.none"] = sha(buildEngineRenderGraph(createDemoProject()));
  values["gpuPreview.paired"] = sha(buildGpuEngineVideoPreviewGraph(nativeFixture(), 2, undefined, undefined, 1) ?? null);
  values["gpuPreview.unversioned"] = sha(buildGpuEngineVideoPreviewGraph(nativeFixture(), 2) ?? null);
  const unpaired = nativeFixture(); unpaired.timelineTransitions = undefined;
  values["gpuPreview.none"] = sha(buildGpuEngineVideoPreviewGraph(unpaired, 2) ?? null);
  const depth = nativeFixture(); depth.scene25d = structuredClone(DEFAULT_SCENE_25D);
  values["gpuPreview.depthDeclined"] = sha(buildGpuEngineVideoPreviewGraph(depth, 2, undefined, undefined, 1) ?? null);
  values["shader.linear"] = sha(timelineTransitionLinearShaderV1());
  // Existing module manifests.
  for (const entry of editkinModuleMetadataRegistryV2().manifests) values[`moduleV2.${entry.id}`] = editkinModuleMetadataRegistryV2().get(entry.id)!.manifestSha256;
  for (const manifest of editkinModuleRegistry().manifests) values[`moduleV1.${manifest.id}`] = editkinModuleRegistry().get(manifest.id)!.manifestSha256;
  // Decoded pixels of the software composite.
  values["pixels.rec709.dissolve"] = await renderPixels(renderFixture("rec709", "dissolve", false), "rec709-dissolve");
  values["pixels.aces2.dip"] = await renderPixels(renderFixture("aces2", "dip", false), "aces2-dip");
  values["pixels.rec709.overlay"] = await renderPixels(renderFixture("rec709", undefined, true), "rec709-overlay");
  values["pixels.aces2.dissolveOverlay"] = await renderPixels(renderFixture("aces2", "dissolve", true), "aces2-dissolve-overlay");
  return values;
}

describe("Motion Library Phase 3 is additive", () => {
  it("projects without the new fields save, validate, build graphs and render exactly as before", async () => {
    const values = await compute();
    if (CAPTURE) {
      await writeFile(GOLDEN, `${JSON.stringify({ schema: "editkin.p3c-additive-identity/v1", capturedBeforePhase3: true, values }, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { capturedBeforePhase3: boolean; values: Record<string, string> };
    expect(golden.capturedBeforePhase3).toBe(true);
    for (const [key, value] of Object.entries(golden.values)) expect({ key, value: values[key] }).toEqual({ key, value });
  }, 300_000);
});
