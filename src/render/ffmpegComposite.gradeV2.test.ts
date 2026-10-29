import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject, type TimelineClip } from "../domain/types";
import { importColorLut } from "../application/creativeLibrary";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});

let work = "";
let graph = "";
let lutFiles: Array<{ path: string; text: string }> = [];
let inverseFiles: Array<{ path: string; lines: string[] }> = [];
const activeGradeCases = new Set<Promise<void>>();
// Drain the entire timed-out case, including later sequential compile calls, before resetting shared mocks.
function trackedGradeCase(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    const pending = action(); activeGradeCases.add(pending);
    try { await pending; } finally { activeGradeCases.delete(pending); }
  };
}
async function waitForGradeCases(): Promise<void> {
  while (activeGradeCases.size) await Promise.allSettled([...activeGradeCases]);
}
afterEach(waitForGradeCases, 40_000);
const previousLutRoot = process.env.EDITKIN_COLOR_LUT_ROOT;
const colorRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)), "public/color/aces2");

beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "editkin-grade-v2-composite-")); process.env.EDITKIN_COLOR_LUT_ROOT = join(work, "luts"); });
afterAll(async () => {
  await waitForGradeCases();
  if (previousLutRoot === undefined) delete process.env.EDITKIN_COLOR_LUT_ROOT; else process.env.EDITKIN_COLOR_LUT_ROOT = previousLutRoot;
  await rm(work, { recursive: true, force: true });
}, 40_000);

beforeEach(async () => {
  await waitForGradeCases();
  graph = ""; lutFiles = []; inverseFiles = [];
  vi.mocked(probeMedia).mockReset(); vi.mocked(runProcess).mockReset();
  vi.mocked(probeMedia).mockResolvedValue({ duration: 6, width: 360, height: 640, encodedWidth: 360, encodedHeight: 640, sampleAspectRatio: 1,
    displayAspectRatio: 9 / 16, hasVideo: true, hasAudio: false, colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" });
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => {
    const inline = args.indexOf("-filter_complex"), script = args.indexOf("-filter_complex_script");
    graph = inline >= 0 ? args[inline + 1] : await readFile(args[script + 1], "utf8");
    for (const match of graph.matchAll(/lut3d=file='([^']+grade-[0-9a-f]+\.cube)'/g)) {
      const path = match[1].replace("\\:", ":");
      lutFiles.push({ path, text: await readFile(path, "utf8") });
    }
    for (const match of new Set([...graph.matchAll(/lut3d=file='([^']+aces-display-inverse\.cube)'/g)].map(item => item[1]))) {
      const path = match.replace("\\:", ":");
      inverseFiles.push({ path, lines: (await readFile(path, "utf8")).trimEnd().split("\n") });
    }
    return { stdout: "", stderr: "" };
  });
}, 40_000);

function project(grade?: ColorGradeV2, extra: Partial<TimelineClip> = {}, aces = false): EditProject {
  const value = createEmptyProject("Grade v2 composite", { width: 360, height: 640, fps: 30 });
  if (aces) value.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
  value.assets.push({ id: "a", name: "a", uri: join(work, "a.mp4"), kind: "video", duration: 6, width: 360, height: 640, color: { interpretation: "rec709" } });
  value.tracks[0].clips.push({ id: "c", trackId: "video-main", assetId: "a", timelineStart: 0, sourceStart: 0, duration: 2, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...(grade ? { gradeV2: grade } : {}), ...extra });
  return value;
}

async function compile(value: EditProject, options: { highBitAlpha?: boolean; colorRoot?: string } = {}) {
  await renderComposite("ffmpeg", "ffprobe", join(work, `out-${Math.random()}.mp4`), value, buildRenderPlan(value, uri => uri), undefined,
    options.highBitAlpha ? "prores_ks" : "libx264", 30_000, undefined, options.colorRoot, undefined, undefined, options.highBitAlpha === true);
}

const LOOK: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_travel_clear_air" } };
const FINISHED: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "n", contrast: 1.1 }],
  finishing: { halation: { amount: 0.2 }, bloom: { amount: 0.1 }, vignette: { amount: 0.3 }, grain: { amount: 0.2, size: 2 } } };

describe("Color Grade v2 export wiring", () => {
  it("bakes one 65³ truncation-compensated LUT and applies it after the primary grade, before effects", trackedGradeCase(async () => {
    await compile(project(LOOK, { color: { ...DEFAULT_COLOR, saturation: 1.1 }, creative: { effectPresetIds: ["film_grain_soft"] } }));
    expect(lutFiles).toHaveLength(1);
    const lines = lutFiles[0].text.trimEnd().split("\n");
    expect(lines[1]).toBe("LUT_3D_SIZE 65");
    expect(lines[0]).toContain("truncation-compensated");
    expect(lines).toHaveLength(65 ** 3 + 2);
    const chain = graph.slice(graph.indexOf("[2:v]"));
    const eq = chain.indexOf("eq=brightness"), lut = chain.indexOf("format=rgba,lut3d=file="), noise = chain.indexOf("noise=alls=7");
    expect(eq).toBeGreaterThan(0); expect(lut).toBeGreaterThan(eq); expect(noise).toBeGreaterThan(lut);
    expect(chain).toContain(":interp=tetrahedral,format=rgba,");
    await expect(stat(dirname(lutFiles[0].path))).rejects.toThrow();
  }), 40_000);

  it("deduplicates identical grades and skips identity grades entirely", trackedGradeCase(async () => {
    const value = project(LOOK);
    value.tracks[0].clips.push({ ...structuredClone(value.tracks[0].clips[0]), id: "c2", timelineStart: 2 });
    await compile(value);
    expect(new Set(lutFiles.map(file => file.path)).size).toBe(1);
    expect(graph.match(/lut3d=file='[^']+grade-/g)).toHaveLength(2);
    await compile(project({ schema: "editkin.color-grade/v2", nodes: [{ id: "off", enabled: false, contrast: 2 }] }));
    expect(graph).not.toContain("lut3d");
    expect(graph).not.toContain("gradepre");
  }), 40_000);

  it("splits the chain for spatial finishing and keeps the layer alpha", trackedGradeCase(async () => {
    await compile(project(FINISHED));
    expect(graph).toContain("[vclip0gradepre]");
    expect(graph).toContain("[vclip0gradepre]format=gbrap,split=2[vclip0gradefx0][vclip0gradefx1]");
    expect(graph).toMatch(/blend=c0_mode=screen:c1_mode=screen:c2_mode=screen:c3_mode=normal/);
    expect(graph).toContain("vignette=angle=0.471239:mode=forward:eval=init:dither=0");
    expect(graph).toContain("c0_mode=multiply");
    expect(graph).toMatch(/format=gray,lut=c0=128,noise=c0s=\d+:c0f=t,gblur=sigma=0\.6:steps=2/);
    expect(graph).toMatch(/\[vclip0gradepost\]format=rgba,format=rgba,setpts=PTS-STARTPTS\+0\[vclip0\]|\[vclip0gradepost\]format=rgba,.*\[vclip0\]/);
    expect(graph).toContain("overlay=");
  }), 40_000);

  it("uses log-domain vignette and the 16-bit surface where required", trackedGradeCase(async () => {
    await compile(project(FINISHED, {}, true), { colorRoot });
    expect(graph).toContain("negate");
    expect(graph).toContain("c0_mode=subtract");
    await compile(project(FINISHED), { highBitAlpha: true });
    expect(graph).toContain("format=gbrap16le,lut3d=file=");
    expect(graph).toContain("[vclip0gradepre]format=gbrap16le,split=2");
    expect(lutFiles.at(-1)!.text.split("\n")[0]).not.toContain("truncation-compensated");
  }), 40_000);

  it("applies finishing after mask alpha is merged", trackedGradeCase(async () => {
    await compile(project(FINISHED, { masks: [createClipMask("m", "ellipse")] }));
    expect(graph).toContain("alphamerge[vclip0merged]");
    expect(graph).toContain("[vclip0merged]");
    expect(graph.indexOf("[vclip0gradepre]")).toBeGreaterThan(graph.indexOf("alphamerge[vclip0merged]"));
  }), 40_000);

  it("reconstructs graded display-referred clips of ACES 2.0 SDR projects with the display inverse, never ungraded ones", trackedGradeCase(async () => {
    // Graded Rec.709 phone clip (even at look strength 0): the display inverse replaces the Camera Rec.709 input LUT.
    await compile(project({ schema: "editkin.color-grade/v2", look: { id: "hfl2_travel_clear_air", strength: 0 } }, {}, true), { colorRoot });
    expect(graph).toMatch(/format=rgba,format=gbrpf32le,lut3d=file='[^']*aces-display-inverse\.cube':interp=tetrahedral/);
    expect(graph).not.toContain("input-rec709-to-acescct");
    expect(graph).toContain("output-acescct-to-rec709_sdr.cube");
    expect(inverseFiles).toHaveLength(1);
    expect(inverseFiles[0].lines[1]).toBe("LUT_3D_SIZE 65");
    expect(inverseFiles[0].lines).toHaveLength(65 ** 3 + 2);
    await expect(stat(dirname(inverseFiles[0].path))).rejects.toThrow();
    // The same project without a v2 grade keeps the shipped input transform (byte-identity corpus covers the rest).
    await compile(project(undefined, {}, true), { colorRoot });
    expect(graph).toContain("input-rec709-to-acescct.cube");
    expect(graph).not.toContain("aces-display-inverse");
    // Graded HLG: the Rec.709 path's BT.2100 display decode + Hable SDR rendering, then the inverse.
    const hlg = project(LOOK, {}, true);
    hlg.assets[0].color = { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" };
    await compile(hlg, { colorRoot });
    expect(graph).toMatch(/zscale=t=linear:npl=100:agamma=0.*tonemap=tonemap=hable:desat=0.*lut3d=file='[^']*aces-display-inverse\.cube'/);
    expect(graph).not.toContain("input-hlg-to-acescct");
    // HDR delivery and scene-referred camera log keep their input transforms.
    const hdr = project(LOOK, {}, true);
    hdr.colorManagement = { ...hdr.colorManagement!, outputTransform: "rec2100_hlg_1000" };
    await compile(hdr, { colorRoot });
    expect(graph).toContain("input-rec709-to-acescct.cube");
    expect(graph).not.toContain("aces-display-inverse");
    const log = project(LOOK, {}, true);
    log.assets[0].color = { interpretation: "apple_log" };
    await compile(log, { colorRoot });
    expect(graph).toContain("input-apple_log-to-acescct.cube");
    expect(graph).not.toContain("aces-display-inverse");
  }), 40_000);

  it("refuses adjustment layers and unknown looks", trackedGradeCase(async () => {
    await expect(compile(project(LOOK, { layer: { enabled: true, role: "adjustment", blendMode: "normal" } }))).rejects.toThrow(/調整圖層/);
    await expect(compile(project({ schema: "editkin.color-grade/v2", look: { id: "hfl2_missing" } }))).rejects.toThrow(/找不到/);
  }), 40_000);

  it("resolves imported LUT nodes from the creative library and refuses a working-space mismatch", trackedGradeCase(async () => {
    const cubePath = join(work, "warm.cube");
    const rows: string[] = [];
    for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${Math.min(1, r * 1.05)} ${g} ${b * 0.95}`);
    await writeFile(cubePath, `TITLE "warm"\nLUT_3D_SIZE 2\n${rows.join("\n")}\n`);
    const entry = await importColorLut(process.env.EDITKIN_COLOR_LUT_ROOT!, { sourcePath: cubePath, name: "Warm test", license: "CC0-1.0",
      provenance: "unit test fixture", rightsBasis: "authored for this test", inputSpace: "rec709_display" });
    const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "lut", lut: { id: entry.id, sha256: entry.sha256, strength: 0.5 } }] };
    await compile(project(grade));
    expect(lutFiles).toHaveLength(1);
    await expect(compile(project(grade, {}, true), { colorRoot: join(work, "aces") })).rejects.toThrow(/工作空間/);
  }), 40_000);
});
