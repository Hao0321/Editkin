import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import type { RenderOptions } from "./ffmpegTypes";
import { renderProject } from "./ffmpeg";
import { probeMedia, runProcess } from "./ffmpegMedia";

const calls = vi.hoisted(() => ({ resident: vi.fn(), encoder: vi.fn(), identity: vi.fn() }));
vi.mock("./residentSceneLinearVideoProject", async original => ({
  ...await original<typeof import("./residentSceneLinearVideoProject")>(),
  renderResidentSceneLinearAces2VideoProject: calls.resident,
}));
vi.mock("./ffmpegComposite", async original => ({
  ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: calls.encoder,
}));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: calls.identity }));

function fixture() {
  const project = createDemoProject();
  project.width = 640; project.height = 360;
  Object.assign(project.assets[0], { uri: "C:/fixture/sdr.mp4", width: 640, height: 360, color: { interpretation: "rec709" } });
  project.tracks[0].clips[0].duration = 1;
  project.captions = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  const graphic = createMotionGraphic("formal-paint", "title", "AV\nO", 0, 1, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48,
    backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0, visualStyle: "native_paint" });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4 };
  graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
    stops: [{ at: 0, color: "#175CD380" }, { at: 1, color: "#FF6000FF" }] }, clips: [] };
  project.motionGraphics = [graphic];
  return project;
}
const options = (): RenderOptions => ({ fontRoot: resolve("public/fonts"), gpuCompositorPath: "source-control-runtime.exe", preferGpu: false });

beforeEach(() => {
  vi.clearAllMocks();
  calls.encoder.mockResolvedValue("libx264");
  calls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  calls.resident.mockImplementation(async (_project, _preview, outputPath) => ({ outputPath, duration: 1,
    encoder: "libx264", planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", ffmpegVersion: "source-control" }));
});

describe("normal renderProject native paint route (source controls, no native process)", () => {
  it("uses verified bundled multiline glyphs and actual current native poses in the shared ACES2 graph", async () => {
    const project = fixture(), before = JSON.stringify(project);
    const result = await renderProject(project, "C:/fixture/output.mp4", options());
    expect(result.planner).toBe("editkin-resident-video-scene-linear-aces2-formal-sequence/v1");
    expect(calls.resident).toHaveBeenCalledTimes(1);
    const graph = calls.resident.mock.calls[0][1].graph;
    const paint = graph.nodes.find((node: { kind: string }) => node.kind === "native_motion_paint");
    expect(paint.graphicId).toBe("formal-paint");
    expect(paint.track.scene.background).toEqual([0, 0, 0, 0]);
    expect(paint.track.scene.layers.length).toBeGreaterThan(1);
    expect(paint.track.scene.layers.every((layer: { path: { commands: unknown[] }; paint: { kind: string } }) => layer.path.commands.length > 0 && layer.paint.kind === "linear")).toBe(true);
    expect(paint.track.timeline).toEqual({ timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 30 });
    expect(paint.track.frames).toHaveLength(30);
    expect(graph.nodes.some((node: { kind: string; processor: string }) => node.kind === "color" && node.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1")).toBe(true);
    expect(JSON.stringify(project)).toBe(before);
  });

  it.each(["runtime", "font", "ordinary-v2", "rec709", "hdr", "coverage"])("refuses %s before encoder or resident execution", async kind => {
    const project = fixture(), selected = options();
    let expected: RegExp;
    if (kind === "runtime") { delete selected.gpuCompositorPath; expected = /GPU compositor runtime/; }
    else if (kind === "font") { delete selected.fontRoot; expected = /pack root/; }
    else if (kind === "ordinary-v2") {
      const ordinary = structuredClone(project.motionGraphics[0]); ordinary.id = "ordinary";
      delete ordinary.paintV1; ordinary.visualStyle = "solid_panel";
      project.motionGraphics.push(ordinary); expected = /全部 v2/;
    } else if (kind === "rec709") { project.colorManagement!.mode = "rec709"; expected = /ACES2 rec709_sdr/; }
    else if (kind === "hdr") { project.colorManagement!.outputTransform = "rec2100_pq_1000"; expected = /HDR/; }
    else { project.tracks[0].clips[0].timelineStart = .5; expected = /coverage 空檔/; }
    await expect(renderProject(project, "C:/fixture/output.mp4", selected)).rejects.toThrow(expected);
    expect(calls.encoder).not.toHaveBeenCalled();
    expect(calls.resident).not.toHaveBeenCalled();
  });

  it("retains the alpha delivery rejection without entering a native paint fallback", async () => {
    await expect(renderProject(fixture(), "C:/fixture/output.mov", { ...options(), deliveryProfile: "prores4444_alpha_10bit" })).rejects.toThrow(/Alpha/);
    expect(calls.encoder).not.toHaveBeenCalled();
    expect(calls.resident).not.toHaveBeenCalled();
  });
});

function toneAmplitude(bytes: Buffer, frequency: number, startSeconds: number): number {
  const sampleRate = 48_000, start = Math.round(startSeconds * sampleRate), count = Math.round(.2 * sampleRate);
  let real = 0, imaginary = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = bytes.readFloatLE((start + index) * 4), angle = 2 * Math.PI * frequency * index / sampleRate;
    real += sample * Math.cos(angle); imaginary -= sample * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / count;
}

describe("resident formal audio stream admission (actual FFmpeg audio, native video execution mocked)", () => {
  it("skips an enabled silent video while retaining delayed video audio and background music without changing sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-resident-audio-streams-"));
    const ffmpegPath = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
    const silent = join(directory, "synthetic-silent.mp4"), voiced = join(directory, "synthetic-video-600hz.mp4"), music = join(directory, "synthetic-music-1000hz.wav");
    try {
      await Promise.all([
        runProcess(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x071B33:s=640x360:r=30", "-t", "4", "-an", "-c:v", "libx264", silent], 30_000),
        runProcess(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x071B33:s=640x360:r=30", "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", voiced], 30_000),
        runProcess(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-t", "4", "-c:a", "pcm_s16le", music], 30_000),
      ]);
      const sourcePaths = [silent, voiced, music];
      const sourceHashes = () => Promise.all(sourcePaths.map(async path => createHash("sha256").update(await readFile(path)).digest("hex")));
      const beforeHashes = await sourceHashes();
      const sourceProbes = await Promise.all(sourcePaths.map(path => probeMedia(path, ffprobePath)));
      expect(sourceProbes.map(probe => probe.hasAudio)).toEqual([false, true, true]);
      type ResidentDependencies = Parameters<typeof import("./residentSceneLinearVideoProject").renderResidentSceneLinearAces2VideoProject>[7];
      calls.resident.mockImplementation(async (project, _preview, outputPath, plan, selected: RenderOptions, _encoder, _timeoutMs, dependencies: ResidentDependencies) => {
        await dependencies.renderAudioBed(project, plan, outputPath, selected.ffmpegPath!, 30_000);
        return { outputPath, duration: plan.duration, encoder: "libx264", planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", ffmpegVersion: "actual-audio-only" };
      });
      const measurements = [];
      for (const mode of ["silent", "music", "mixed"] as const) {
        const project = fixture();
        Object.assign(project.assets[0], { uri: silent, duration: 4 });
        const first = project.tracks[0].clips[0]; first.duration = 4;
        if (mode === "mixed") {
          project.assets.push({ ...project.assets[0], id: "voiced-control", uri: voiced, duration: 2 });
          first.duration = 2;
          project.tracks[0].clips.push({ ...structuredClone(first), id: "voiced-clip", assetId: "voiced-control", timelineStart: 2, volume: .6 });
        }
        if (mode !== "silent") {
          project.assets.push({ ...project.assets[0], id: "music-control", kind: "audio", role: "background-music", uri: music });
          project.tracks.push({ id: "music-control-track", name: "Synthetic music control", kind: "audio", muted: false, locked: false,
            clips: [{ ...structuredClone(first), id: "music-control-clip", trackId: "music-control-track", assetId: "music-control", duration: 4, volume: .3 }] });
        }
        const beforeProject = JSON.stringify(project), output = join(directory, `${mode}.m4a`);
        await renderProject(project, output, { ...options(), ffmpegPath, ffprobePath, timeoutMs: 30_000 });
        expect(JSON.stringify(project)).toBe(beforeProject);
        const probe = await probeMedia(output, ffprobePath);
        expect(probe.hasAudio).toBe(true); expect(probe.hasVideo).toBe(false); expect(probe.duration).toBeCloseTo(4, 1);
        const decoded = spawnSync(ffmpegPath, ["-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { windowsHide: true, maxBuffer: 2_000_000, timeout: 30_000 });
        expect(decoded.status, decoded.stderr.toString()).toBe(0);
        const windows = [.6, 2.6].map(start => ({ start, video600: toneAmplitude(decoded.stdout, 600, start), music1000: toneAmplitude(decoded.stdout, 1000, start) }));
        if (mode === "silent") {
          let maximum = 0;
          for (let index = 0; index + 4 <= decoded.stdout.length; index += 4) maximum = Math.max(maximum, Math.abs(decoded.stdout.readFloatLE(index)));
          expect(maximum).toBeLessThan(1e-7);
        } else {
          for (const window of windows) expect(window.music1000).toBeGreaterThan(.002);
          expect(windows[0].video600 / windows[0].music1000).toBeLessThan(.001);
          if (mode === "mixed") expect(windows[1].video600).toBeGreaterThan(.005);
          else expect(windows[1].video600 / windows[1].music1000).toBeLessThan(.001);
        }
        measurements.push({ mode, duration: probe.duration, windows });
      }
      expect(await sourceHashes()).toEqual(beforeHashes);
      console.log("RESIDENT_AUDIO_STREAM_REGRESSION", JSON.stringify({ classification: "SYNTHETIC_AUDIO_ONLY_NATIVE_VIDEO_MOCKED", sourceHasAudio: sourceProbes.map(probe => probe.hasAudio), immutableSourceHashes: beforeHashes, measurements }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
