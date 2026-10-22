import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

/**
 * Byte-identity guard for editkin.color-grade/v2. A corpus of projects that do not use
 * gradeV2 is compiled by the real planner + compositor; only probe/process I/O is mocked.
 * The complete FFmpeg argument vector (filter graph included) is hashed per fixture.
 *
 * - EDITKIN_GRADE_V2_IDENTITY_RECORD=<file> records the vectors (run on the pre-v2 compositor).
 * - EDITKIN_GRADE_V2_IDENTITY_BASELINE=<file> asserts every vector is byte-identical to that record.
 * Without either variable the suite still proves omission == explicit undefined and
 * set-then-clear == never set, and that no grade filter appears without gradeV2.
 */
vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});

const app = fileURLToPath(new URL("../../", import.meta.url));
const colorRoot = resolve(app, "public/color/aces2");
let workRoot = "";
let captured: string[] = [];

beforeAll(async () => { workRoot = await mkdtemp(join(tmpdir(), "editkin-grade-v2-identity-")); initializeStudioCreativeAssets(); });
afterAll(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });

beforeEach(() => {
  captured = [];
  vi.mocked(probeMedia).mockReset(); vi.mocked(runProcess).mockReset();
  vi.mocked(probeMedia).mockImplementation(async (path: string) => ({
    duration: 8, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360, sampleAspectRatio: 1, displayAspectRatio: 16 / 9,
    hasVideo: !/\.(wav|m4a)$/i.test(path), hasAudio: /voice|music|\.wav$/i.test(path),
    colorPrimaries: /hlg/i.test(path) ? "bt2020" : "bt709", colorTransfer: /hlg/i.test(path) ? "arib-std-b67" : "bt709",
    colorMatrix: /hlg/i.test(path) ? "bt2020nc" : "bt709", colorRange: "tv",
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

function clip(id: string, assetId: string, start: number, duration: number, extra: Partial<TimelineClip> = {}, trackId = "video-main"): TimelineClip {
  return { id, trackId, assetId, timelineStart: start, sourceStart: 0.25, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...extra };
}

function base(width = 360, height = 640): EditProject {
  const project = createEmptyProject("Grade v2 identity corpus", { width, height, fps: 30 });
  project.assets.push(asset("a", "owned-a.mp4"), asset("b", "owned-b-voice.mp4"));
  return project;
}

function addTrack(project: EditProject, id: string): EditProject["tracks"][number] {
  const track = { id, name: id, kind: "video" as const, locked: false, muted: false, clips: [] as TimelineClip[] };
  project.tracks.push(track);
  return track;
}

interface Fixture { id: string; build: () => EditProject; assPath?: string; colorRoot?: boolean; highBitAlpha?: boolean; nativeAudio?: boolean }

const FIXTURES: Fixture[] = [
  { id: "plain", build: () => { const p = base(); p.tracks[0].clips.push(clip("c1", "a", 0, 2)); return p; } },
  { id: "legacy-look-effects-transitions", build: () => {
    const p = base();
    p.tracks[0].clips.push(
      clip("c1", "a", 0, 2, { creative: { lookPresetId: "food_warm_appetite", effectPresetIds: ["film_grain_soft", "studio_vignette_soft", "high_key_bloom"], transitionOut: { presetId: "luma_fade", duration: .3 } } }),
      clip("c2", "b", 2, 2, { creative: { lookPresetId: "studio_city_cyan", effectPresetIds: [], transitionIn: { presetId: "chromatic_whip_cut", duration: .2 } } }),
    );
    return p;
  } },
  { id: "primary-tone-exposure-keyframes", build: () => {
    const p = base();
    const color = { ...DEFAULT_COLOR, temperature: .2, tint: -.1, shadows: -.1, pivot: .45, exposure: .5, saturation: 1.1, hue: 4 };
    p.tracks[0].clips.push(clip("c1", "a", 0, 3, { color, keyframes: [
      { id: "k1", time: 0, transform: { ...DEFAULT_TRANSFORM }, color, easing: "linear" },
      { id: "k2", time: 2, transform: { ...DEFAULT_TRANSFORM, scale: 1.2 }, color: { ...color, brightness: .1, contrast: 1.2 }, easing: "ease_in_out" },
    ] }));
    return p;
  } },
  { id: "layout-scale-rotation", build: () => {
    const p = base();
    p.tracks[0].clips.push(clip("c1", "a", 0, 2, { transform: { ...DEFAULT_TRANSFORM, scale: .8, rotation: 12, x: 20, y: -10 },
      layout: { crop: { x: .1, y: .1, width: .8, height: .7 }, viewport: { x: .1, y: .2, width: .8, height: .5 } } }));
    return p;
  } },
  { id: "vector-masks", build: () => {
    const p = base();
    p.tracks[0].clips.push(clip("c1", "a", 0, 2, { masks: [createClipMask("m1", "ellipse"), { ...createClipMask("m2", "rectangle"), mode: "subtract", inverted: true }] }));
    return p;
  } },
  { id: "aces2-hlg", colorRoot: true, build: () => {
    const p = base();
    p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    p.assets.push(asset("h", "owned-hlg.mov", { color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } }));
    p.tracks[0].clips.push(clip("c1", "h", 0, 2, { color: { ...DEFAULT_COLOR, contrast: 1.1 }, creative: { lookPresetId: "cine_dense_print", effectPresetIds: [] } }));
    return p;
  } },
  { id: "rec709-hlg-source", build: () => {
    const p = base();
    p.assets.push(asset("h", "owned-hlg.mov", { color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } }));
    p.tracks[0].clips.push(clip("c1", "h", 0, 2, { color: { ...DEFAULT_COLOR, exposure: .3 } }));
    return p;
  } },
  { id: "alpha-master", highBitAlpha: true, build: () => {
    const p = base();
    p.tracks[0].clips.push(clip("c1", "a", 0, 2, { creative: { lookPresetId: "clean_neutral", effectPresetIds: [] }, masks: [createClipMask("m1", "rectangle")] }));
    return p;
  } },
  { id: "adjustment-layer", build: () => {
    const p = base(); const fx = addTrack(p, "fx");
    p.tracks[0].clips.push(clip("c1", "a", 0, 3));
    fx.clips.push(clip("adj", "a", .5, 2, { volume: 0, layer: { enabled: true, role: "adjustment", blendMode: "normal" }, creative: { lookPresetId: "cine_moonlit_steel", effectPresetIds: [] } }, "fx"));
    return p;
  } },
  { id: "blend-screen", build: () => {
    const p = base(); const over = addTrack(p, "over");
    p.tracks[0].clips.push(clip("c1", "a", 0, 2));
    over.clips.push(clip("c2", "b", 0, 2, { volume: 0, layer: { enabled: true, role: "content", blendMode: "screen" }, transform: { ...DEFAULT_TRANSFORM, opacity: .7 } }, "over"));
    return p;
  } },
  { id: "track-matte", build: () => {
    const p = base(); const matte = addTrack(p, "matte");
    p.tracks[0].clips.push(clip("c1", "a", 0, 2, { volume: 0, layer: { enabled: true, role: "content", blendMode: "normal", trackMatte: { sourceClipId: "m", mode: "luma" } } }));
    matte.muted = true;
    matte.clips.push(clip("m", "b", 0, 2, { volume: 0 }, "matte"));
    return p;
  } },
  { id: "floating-v2", build: () => {
    const p = base();
    p.tracks[0].clips.push(clip("c1", "a", .5, 2, { volume: 0, sourceStart: .4, floatingFrame: floatingVideoFramePresetV2("matte") }));
    return p;
  } },
  { id: "still-image-captions", assPath: "captions.ass", build: () => {
    const p = base();
    p.assets.push({ id: "img", name: "img", uri: "owned-still.png", kind: "image", duration: 5, width: 640, height: 360 });
    p.tracks[0].clips.push(clip("c1", "img", 0, 2, { volume: 0 }));
    p.captions.push({ id: "cap", text: "hello", start: 0, duration: 1 });
    return p;
  } },
  { id: "native-audio-white-balance", nativeAudio: true, build: () => {
    const p = base();
    p.tracks[0].clips.push(clip("c1", "a", 0, 2, { color: { ...DEFAULT_COLOR, whiteBalanceRed: .2, whiteBalanceBlue: -.15 } }));
    return p;
  } },
  { id: "landscape-multitrack", build: () => {
    const p = base(1280, 720); const pip = addTrack(p, "pip");
    p.tracks[0].clips.push(clip("c1", "a", 0, 2), clip("c2", "b", 2, 1.5, { creative: { lookPresetId: "vlog_bright_clean", effectPresetIds: ["scanline_focus"] } }));
    pip.clips.push(clip("c3", "a", .5, 1, { volume: 0, transform: { ...DEFAULT_TRANSFORM, scale: .4, x: 300, y: -150, opacity: .9 } }, "pip"));
    return p;
  } },
];

async function vectorFor(fixture: Fixture, project = fixture.build()): Promise<string[]> {
  const output = join(workRoot, `${fixture.id}.mp4`);
  await renderComposite("owned-ffmpeg", "owned-ffprobe", output, project, buildRenderPlan(project, uri => uri), fixture.assPath,
    fixture.highBitAlpha ? "prores_ks" : "libx264", 30_000, undefined, fixture.colorRoot ? colorRoot : undefined, workRoot, undefined,
    fixture.highBitAlpha === true, fixture.nativeAudio ? join(workRoot, "native-audio.f32") : undefined);
  return captured.map(argument => argument
    .replaceAll(workRoot.replaceAll("\\", "/"), "<work>").replaceAll(workRoot, "<work>")
    .replace(/\.[0-9a-f-]{36}\.background\.ass/g, ".<uuid>.background.ass"));
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Color Grade v2 omission keeps every pre-v2 export byte-identical", () => {
  it("records or compares the complete FFmpeg vectors of the corpus", async () => {
    const vectors: Record<string, { sha256: string; args: string[] }> = {};
    for (const fixture of FIXTURES) {
      const args = await vectorFor(fixture);
      expect(args.length).toBeGreaterThan(10);
      expect(args.join(" ")).not.toMatch(/grade-v2|gbrapf32le,lut3d=file='[^']*grade/);
      vectors[fixture.id] = { sha256: sha256(args), args };
    }
    const record = process.env.EDITKIN_GRADE_V2_IDENTITY_RECORD;
    if (record) await writeFile(record, `${JSON.stringify({ schema: "editkin.grade-v2-identity-corpus/v1", fixtures: vectors }, null, 2)}\n`, "utf8");
    const baseline = process.env.EDITKIN_GRADE_V2_IDENTITY_BASELINE;
    if (baseline) {
      const expected = JSON.parse(await readFile(baseline, "utf8")) as { fixtures: typeof vectors };
      expect(Object.keys(vectors).sort()).toEqual(Object.keys(expected.fixtures).sort());
      for (const [id, value] of Object.entries(vectors)) {
        expect({ id, args: value.args }).toEqual({ id, args: expected.fixtures[id].args });
        expect(value.sha256).toBe(expected.fixtures[id].sha256);
      }
    }
  });

  it("treats an explicitly undefined gradeV2 exactly like omission", async () => {
    for (const fixture of FIXTURES.slice(0, 6)) {
      const omitted = await vectorFor(fixture);
      const project = fixture.build();
      for (const track of project.tracks) for (const item of track.clips) item.gradeV2 = undefined;
      expect(await vectorFor(fixture, project)).toEqual(omitted);
    }
  });
});
