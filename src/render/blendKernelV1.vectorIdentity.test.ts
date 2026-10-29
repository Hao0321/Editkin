import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

/**
 * Blend kernel v1 (P1) / ACES scene-linear blend (P2) / track matte (P3) omission identity: projects whose layers are
 * all `normal` (no track matte) must compile to byte-identical FFmpeg argument vectors. The golden SHA-256 values
 * beside this test were captured from the source before the kernel existed (EDITKIN_BLEND_IDENTITY_CAPTURE=1 on the
 * pre-change tree, 2026-10-22). Only probe/process I/O is mocked; planner and compositor are real.
 */
vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});

const GOLDEN = resolve(fileURLToPath(new URL(".", import.meta.url)), "blendKernelV1.vectorIdentity.golden.json");
const CAPTURE = process.env.EDITKIN_BLEND_IDENTITY_CAPTURE === "1";
const app = fileURLToPath(new URL("../../", import.meta.url));
const colorRoot = resolve(app, "public/color/aces2");
let workRoot = "";
let captured: string[] = [];

beforeAll(async () => { workRoot = await mkdtemp(join(tmpdir(), "editkin-blend-identity-")); initializeStudioCreativeAssets(); });
afterAll(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });

beforeEach(() => {
  captured = [];
  vi.mocked(probeMedia).mockReset(); vi.mocked(runProcess).mockReset();
  vi.mocked(probeMedia).mockImplementation(async (path: string) => ({
    duration: 8, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360, sampleAspectRatio: 1, displayAspectRatio: 16 / 9,
    hasVideo: !/\.wav$/i.test(path), hasAudio: /voice|\.wav$/i.test(path),
    colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv",
  }));
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => {
    const vector = [...args];
    const script = vector.indexOf("-filter_complex_script");
    if (script >= 0) vector[script + 1] = `<script>${await readFile(vector[script + 1], "utf8")}`;
    captured = vector;
    return { stdout: "", stderr: "" };
  });
});

function asset(id: string, uri: string, extra: Partial<MediaAsset> = {}): MediaAsset {
  return { id, name: id, uri, kind: "video", duration: 8, width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" }, ...extra };
}
function clip(id: string, assetId: string, trackId: string, start: number, duration: number, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { id, trackId, assetId, timelineStart: start, sourceStart: 0.25, duration, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...extra };
}
function stack(project: EditProject): EditProject {
  project.assets.push(asset("a", "owned-a.mp4"), asset("b", "owned-b-voice.mp4"),
    { id: "still", name: "still", uri: "owned-alpha.png", kind: "image", duration: 5, width: 640, height: 360, alphaMode: "straight" });
  project.tracks[0].clips.push(clip("c1", "a", project.tracks[0].id, 0, 2, { volume: 1 }), clip("c2", "b", project.tracks[0].id, 2, 1.5, { volume: 1 }));
  project.tracks.push({ id: "over", name: "over", kind: "video", locked: false, muted: false, clips: [
    clip("o1", "still", "over", 0.5, 1.5, { transform: { ...DEFAULT_TRANSFORM, opacity: 0.6, scale: 0.7, x: 40, y: -20, rotation: 8 }, layer: { enabled: true, blendMode: "normal", role: "content" } }),
    clip("o2", "a", "over", 2.2, 1, { masks: [createClipMask("m1", "ellipse")], layer: { enabled: true, blendMode: "normal" } }),
  ] });
  return project;
}

interface Fixture { id: string; build: () => EditProject; colorRoot?: boolean; highBitAlpha?: boolean }
const FIXTURES: Fixture[] = [
  { id: "rec709-normal-stack", build: () => stack(createEmptyProject("Identity", { id: "identity", width: 640, height: 360, fps: 30 })) },
  { id: "rec709-normal-alpha-master", highBitAlpha: true, build: () => stack(createEmptyProject("Identity", { id: "identity", width: 640, height: 360, fps: 30 })) },
  { id: "aces2-phone-normal-stack", colorRoot: true, build: () => {
    const p = stack(createPhoneProjectV1("Identity", { id: "identity", width: 640, height: 360, fps: 30 }));
    p.colorManagement = { ...p.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    return p;
  } },
  { id: "aces2-legacy-normal-stack", colorRoot: true, build: () => {
    const p = stack(createEmptyProject("Identity", { id: "identity", width: 640, height: 360, fps: 30 }));
    p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    return p;
  } },
  { id: "rec709-adjustment-and-hidden-track", build: () => {
    const p = stack(createEmptyProject("Identity", { id: "identity", width: 640, height: 360, fps: 30 }));
    p.tracks.push({ id: "fx", name: "fx", kind: "video", locked: false, muted: false, clips: [
      clip("adj", "a", "fx", 0.5, 2, { layer: { enabled: true, role: "adjustment", blendMode: "normal" }, creative: { lookPresetId: "cine_moonlit_steel", effectPresetIds: [] } })] });
    p.tracks.push({ id: "hidden", name: "hidden", kind: "video", locked: false, muted: false, hidden: true, clips: [clip("h", "b", "hidden", 0, 3)] });
    return p;
  } },
];

async function vectorFor(fixture: Fixture): Promise<string[]> {
  const project = fixture.build();
  await renderComposite("owned-ffmpeg", "owned-ffprobe", join(workRoot, `${fixture.id}.mp4`), project, buildRenderPlan(project, uri => uri), undefined,
    fixture.highBitAlpha ? "prores_ks" : "libx264", 30_000, undefined, fixture.colorRoot ? colorRoot : undefined, workRoot, undefined, fixture.highBitAlpha === true);
  // The checkout location is not content: the colour resources' absolute path (plain or filter-escaped) is normalized.
  return captured.map(argument => argument.replaceAll(workRoot.replaceAll("\\", "/"), "<work>").replaceAll(workRoot, "<work>")
    .replace(/[A-Za-z]\\{0,2}:[\\/][^'"]*?public[\\/]color[\\/]aces2/g, "<colorRoot>")
    // Per-render work directories (display-inverse LUT and other temporary files) have random names.
    .replace(/[A-Za-z]\\{0,2}:[\\/][^'"]*?editkin-(?:render|filtergraph|blend-identity)-[A-Za-z0-9_-]+/g, "<renderWork>"));
}

describe("normal-only projects keep byte-identical export vectors (blend kernel / ACES blend / track matte changes)", () => {
  it("matches the vectors captured before the blend kernel", async () => {
    const values: Record<string, string> = {};
    for (const fixture of FIXTURES) {
      const args = await vectorFor(fixture);
      expect(args.length).toBeGreaterThan(10);
      expect(args.join(" ")).not.toMatch(/lut2=|blend=c0_expr|straightCanvas/);
      values[fixture.id] = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    }
    if (CAPTURE) {
      await writeFile(GOLDEN, `${JSON.stringify({ schema: "editkin.blend-kernel-vector-identity/v1", capturedBeforeKernel: true, values }, null, 2)}\n`, "utf8");
      return;
    }
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { values: Record<string, string> };
    expect(values).toEqual(golden.values);
  }, 120_000);
});
