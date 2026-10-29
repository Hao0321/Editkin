import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import type { VideoEncoder } from "./ffmpegTypes";
import { prepareParityImagesV1 } from "./parity/blendParityHarnessV1";

/**
 * Real exports of normal-only projects (no blend mode, no track matte) decode to the same pixels as before the blend
 * kernel, the ACES scene-linear blend and the track-matte changes. Golden SHA-256 of every decoded frame were captured
 * from the pre-change source (EDITKIN_BLEND_IDENTITY_CAPTURE=1, 2026-10-22).
 */
const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const app = resolve(here, "../..");
const GOLDEN = resolve(here, "blendKernelV1.renderIdentity.golden.json");
const CAPTURE = process.env.EDITKIN_BLEND_IDENTITY_CAPTURE === "1";
const ffmpeg = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const colorRoot = resolve(app, "public/color/aces2");
let root = "";
let paths: Record<"backdrop" | "source" | "target" | "matte", string>;

beforeAll(async () => {
  initializeStudioCreativeAssets();
  root = await mkdtemp(join(tmpdir(), "editkin-blend-render-identity-"));
  ({ paths } = await prepareParityImagesV1(join(root, "images")));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function clip(id: string, assetId: string, trackId: string, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: 0.2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...extra };
}
function normalStack(project: EditProject): EditProject {
  for (const name of ["backdrop", "source", "target"] as const) project.assets.push({ id: name, name, uri: paths[name], kind: "image", duration: 5, width: 64, height: 48 });
  project.tracks[0].clips.push(clip("base", "backdrop", project.tracks[0].id));
  project.tracks.push({ id: "mid", name: "mid", kind: "video", locked: false, muted: false, clips: [
    clip("mid", "target", "mid", { transform: { ...DEFAULT_TRANSFORM, scale: 0.6, rotation: 12, x: 6, y: -4, opacity: 0.8 }, layer: { enabled: true, blendMode: "normal", role: "content" } })] });
  project.tracks.push({ id: "top", name: "top", kind: "video", locked: false, muted: false, clips: [
    clip("top", "source", "top", { transform: { ...DEFAULT_TRANSFORM, opacity: 0.6 }, layer: { enabled: true, blendMode: "normal" } })] });
  return project;
}

interface Fixture { id: string; build: () => EditProject; encoder: VideoEncoder; aces?: boolean; alpha?: boolean; decode: "rgb24" | "gbrap16le" }
const FIXTURES: Fixture[] = [
  { id: "rec709-ffv1", encoder: "ffv1", decode: "rgb24", build: () => normalStack(createEmptyProject("Identity", { id: "identity", width: 64, height: 48, fps: 30 })) },
  { id: "rec709-libx264", encoder: "libx264", decode: "rgb24", build: () => normalStack(createEmptyProject("Identity", { id: "identity", width: 64, height: 48, fps: 30 })) },
  { id: "rec709-alpha16-ffv1", encoder: "ffv1", alpha: true, decode: "gbrap16le", build: () => normalStack(createEmptyProject("Identity", { id: "identity", width: 64, height: 48, fps: 30 })) },
  { id: "aces2-phone-ffv1", encoder: "ffv1", aces: true, decode: "rgb24", build: () => {
    const p = normalStack(createPhoneProjectV1("Identity", { id: "identity", width: 64, height: 48, fps: 30 }));
    p.colorManagement = { ...p.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    return p;
  } },
];

describe.skipIf(!existsSync(ffmpeg))("normal-only real exports are pixel-identical to the pre-kernel source", () => {
  it("decoded frames match the captured golden", async () => {
    const values: Record<string, string> = {};
    for (const fixture of FIXTURES) {
      const project = fixture.build();
      const output = join(root, `${fixture.id}.${fixture.encoder === "ffv1" ? "mkv" : "mp4"}`);
      await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, fixture.encoder, 120_000, undefined,
        fixture.aces ? colorRoot : undefined, undefined, undefined, fixture.alpha === true);
      const { stdout } = await run(ffmpeg, ["-v", "error", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", fixture.decode, "pipe:1"],
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      expect(stdout.length).toBeGreaterThan(0);
      values[fixture.id] = createHash("sha256").update(stdout).digest("hex");
    }
    if (CAPTURE) {
      await writeFile(GOLDEN, `${JSON.stringify({ schema: "editkin.blend-kernel-render-identity/v1", capturedBeforeKernel: true, values }, null, 2)}\n`, "utf8");
      return;
    }
    expect(values).toEqual((JSON.parse(await readFile(GOLDEN, "utf8")) as { values: Record<string, string> }).values);
  }, 300_000);
});
