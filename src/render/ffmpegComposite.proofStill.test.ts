import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { proofStillDefaultLayoutV1, proofStillOutputRectV1, type ProofStillRectV1, type ProofStillV1 } from "../domain/proofStillV1";
import { compositorVideoFilters, renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
function run(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, args, { windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const rgb = (fill: string) => [1, 3, 5].map(index => parseInt(fill.slice(index, index + 2), 16));

/** Synthetic owned still (lavfi test pattern), never personal media. */
async function source(root: string, width: number, height: number) {
  const path = join(root, `shot-${width}x${height}.png`);
  run(["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:d=1`, "-frames:v", "1", "-vf", "format=rgb24", path]);
  return { path, bytes: await readFile(path) };
}

function proofProject(path: string, bytes: Buffer, canvas: { width: number; height: number }, sourceSize: { width: number; height: number },
  crop: ProofStillRectV1, redactions: ProofStillV1["redactions"]) {
  const project = createEmptyProject("Proof still render", { ...canvas, fps: 10 });
  const proofStill: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: sha(bytes), sourceWidth: sourceSize.width, sourceHeight: sourceSize.height,
    crop, redactions, hold: "static", confirmation: { by: "agent", note: "Synthetic test pattern; listed regions confirmed by the test." } };
  const layout = proofStillDefaultLayoutV1(proofStill, canvas);
  project.assets.push({ id: "shot", name: "Owned shot", kind: "image", uri: path, duration: 5, width: sourceSize.width, height: sourceSize.height });
  project.tracks[0].clips.push({ id: "proof", assetId: "shot", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: .5, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layout, proofStill });
  return { project, proofStill, layout };
}

async function renderLossless(root: string, project: EditProject, name: string) {
  const output = join(root, `${name}.mkv`);
  // Lossless intermediate: the composite's own 16-bit RGBA precomposition route (FFV1, gbrap16le).
  await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 120000,
    undefined, undefined, undefined, undefined, true);
  return output;
}
/** Decoded at the fill's own 8-bit precision. The precomposition plane is 16-bit, but its
 * overlay stage carries 10-bit precision (alpha 65472 = 1023<<6), so 16-bit words are not v*257. */
function decodeFrame(path: string, frame: number, format: "rgb24" | "rgba") {
  return run(["-v", "error", "-i", path, "-map", "0:v:0", "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-pix_fmt", format, "-f", "rawvideo", "pipe:1"]);
}

describe("FFmpeg composite proof-still redaction (design P3)", () => {
  it("draws every redaction as its exact fill in the decoded lossless output, in source pixels, without rewriting the original", async () => {
    const root = await temp.create("ps-"), { path, bytes } = await source(root, 320, 180);
    const redactions = [
      { id: "email", rect: { x: 16, y: 20, width: 64, height: 40 }, fill: "#13579B" },
      { id: "token", rect: { x: 200, y: 100, width: 80, height: 50 }, fill: "#F2A900" },
      { id: "overlap", rect: { x: 60, y: 50, width: 40, height: 30 }, fill: "#000000" },
    ];
    const { project } = proofProject(path, bytes, { width: 320, height: 180 }, { width: 320, height: 180 }, { x: 0, y: 0, width: 320, height: 180 }, redactions);
    const output = await renderLossless(root, project, "identity");
    const reference = run(["-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    for (const frame of [0, 4]) {
      const pixels = decodeFrame(output, frame, "rgba");
      expect(pixels.length).toBe(320 * 180 * 4);
      const at = (x: number, y: number) => [...pixels.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
      const source = (x: number, y: number) => [...reference.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
      // Later redactions are drawn over earlier ones, exactly as listed.
      const owner = (x: number, y: number) => [...redactions].reverse().find(r => x >= r.rect.x && x < r.rect.x + r.rect.width && y >= r.rect.y && y < r.rect.y + r.rect.height);
      let inside = 0, outside = 0;
      const wrongInside: string[] = [], wrongOutside: string[] = [];
      for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
        const region = owner(x, y);
        if (region) {
          inside++;
          // Every pixel inside a rectangle: exactly the fill and fully opaque.
          if (JSON.stringify(at(x, y)) !== JSON.stringify([...rgb(region.fill), 255])) wrongInside.push(`${region.id}@${x},${y}:${at(x, y)}`);
        } else {
          // Outside, the still is untouched (identity geometry).
          outside++;
          if (at(x, y).slice(0, 3).some((value, c) => Math.abs(value - source(x, y)[c]) > 1) || at(x, y)[3] !== 255) wrongOutside.push(`${x},${y}`);
        }
      }
      expect(wrongInside, `frame ${frame}`).toEqual([]);
      expect(wrongOutside.slice(0, 8), `frame ${frame}`).toEqual([]);
      expect(inside).toBe(64 * 40 + 80 * 50 + 40 * 30 - 20 * 10);
      expect(outside).toBe(320 * 180 - inside);
    }
    expect(sha(await readFile(path))).toBe(sha(bytes));
  }, 180000);

  it("crops in source pixels: a 2x-oversized still whose crop fills the viewport 1:1 is never resampled, so every redacted pixel is exact", async () => {
    const root = await temp.create("ps-"), { path, bytes } = await source(root, 640, 360);
    const redactions = [{ id: "secret", rect: { x: 200, y: 120, width: 120, height: 80 }, fill: "#E0115F" }];
    const { project, proofStill, layout } = proofProject(path, bytes, { width: 320, height: 180 }, { width: 640, height: 360 }, { x: 160, y: 90, width: 320, height: 180 }, redactions);
    const output = await renderLossless(root, project, "scaled");
    // The 320x180 source crop is drawn straight into the 320x180 viewport: the rect lands at (40,30,120,80) with no resampling.
    const rect = proofStillOutputRectV1(proofStill, redactions[0].rect, layout, { width: 320, height: 180 });
    expect([rect.x * 320, rect.y * 180, rect.width * 320, rect.height * 180].map(v => Math.round(v * 1e6) / 1e6)).toEqual([40, 30, 120, 80]);
    const pixels = decodeFrame(output, 2, "rgba"), fill = JSON.stringify([...rgb("#E0115F"), 255]);
    const exact: Array<[number, number]> = [];
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const index = (y * 320 + x) * 4;
      if (JSON.stringify([...pixels.subarray(index, index + 4)]) === fill) exact.push([x, y]);
    }
    // Every pixel inside the rectangle is the fill, and the fill covers exactly the rectangle.
    expect(exact.length).toBe(120 * 80);
    expect(exact.every(([x, y]) => x >= 40 && x < 160 && y >= 30 && y < 110)).toBe(true);
    // The pixels beside the crop edge are the source's own (cropped, not resampled): compare with the literal source crop.
    const reference = run(["-v", "error", "-i", path, "-vf", "crop=320:180:160:90", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
    let differing = 0;
    for (let i = 0; i < 320 * 180; i++) {
      const x = i % 320, y = Math.floor(i / 320);
      if (x >= 40 && x < 160 && y >= 30 && y < 110) continue;
      if ([0, 1, 2].some(c => Math.abs(pixels[i * 4 + c] - reference[i * 4 + c]) > 1)) differing++;
    }
    expect(differing).toBe(0);
    expect(sha(await readFile(path))).toBe(sha(bytes));
  }, 180000);

  it("a non-1:1 viewport is resampled once with Lanczos: the redaction interior stays exact", async () => {
    const root = await temp.create("ps-"), { path, bytes } = await source(root, 640, 360);
    const redactions = [{ id: "secret", rect: { x: 200, y: 120, width: 120, height: 80 }, fill: "#E0115F" }];
    // Crop 400x225 into a 320x180 viewport: one x0.8 resample; the rect lands at (64,48,96,64).
    const { project } = proofProject(path, bytes, { width: 320, height: 180 }, { width: 640, height: 360 }, { x: 120, y: 60, width: 400, height: 225 }, redactions);
    const pixels = decodeFrame(await renderLossless(root, project, "single"), 2, "rgba"), inset = 4, wrong: string[] = [];
    for (let y = 48 + inset; y < 112 - inset; y++) for (let x = 64 + inset; x < 160 - inset; x++) {
      const index = (y * 320 + x) * 4;
      if (JSON.stringify([...pixels.subarray(index, index + 4)]) !== JSON.stringify([...rgb("#E0115F"), 255])) wrong.push(`${x},${y}`);
    }
    expect(wrong).toEqual([]);
  }, 180000);

  it("the delivery H.264 route also covers the region (lossy, so within quantization), never the original content", async () => {
    const root = await temp.create("ps-"), { path, bytes } = await source(root, 320, 180);
    const redactions = [{ id: "card", rect: { x: 100, y: 40, width: 96, height: 64 }, fill: "#2E7D32" }];
    const { project } = proofProject(path, bytes, { width: 320, height: 180 }, { width: 320, height: 180 }, { x: 0, y: 0, width: 320, height: 180 }, redactions);
    const output = join(root, "delivery.mp4");
    await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 120000);
    const pixels = decodeFrame(output, 2, "rgb24"), reference = run(["-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    const [r, g, b] = rgb("#2E7D32");
    let differsFromSource = 0;
    for (let y = 44; y < 100; y++) for (let x = 104; x < 192; x++) {
      const i = (y * 320 + x) * 3;
      expect(Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b), `${x},${y}`).toBeLessThanOrEqual(9);
      if (Math.abs(reference[i] - r) + Math.abs(reference[i + 1] - g) + Math.abs(reference[i + 2] - b) > 30) differsFromSource++;
    }
    expect(differsFromSource).toBeGreaterThan(1000);
  }, 180000);

  it("refuses before encoding when the source bytes changed after preparation, and adds no filter without a proof still", async () => {
    const root = await temp.create("ps-"), { path, bytes } = await source(root, 320, 180);
    const { project } = proofProject(path, bytes, { width: 320, height: 180 }, { width: 320, height: 180 }, { x: 0, y: 0, width: 320, height: 180 },
      [{ id: "name", rect: { x: 8, y: 8, width: 32, height: 16 }, fill: "#FFFFFF" }]);
    await writeFile(path, Buffer.concat([bytes, Buffer.from("tampered")]));
    const output = join(root, "refused.mkv");
    await expect(renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 60000,
      undefined, undefined, undefined, undefined, true)).rejects.toThrow(/^PROOF_STILL_SOURCE_SHA_MISMATCH/);
    await expect(readFile(output)).rejects.toThrow();
    // The same clip without proofStill compiles the unchanged source chain (no drawbox, no added format step).
    const plain = structuredClone(project), clip = plain.tracks[0].clips[0];
    delete clip.proofStill; delete clip.layout;
    const input = { clip, asset: plain.assets[0], assetPath: path, inputIndex: 2, alphaPlan: compileClipAlphaPlan(plain, clip, "formal"),
      probe: { duration: 0, width: 320, height: 180, hasVideo: true, hasAudio: false } };
    const graph = compositorVideoFilters(input, "vclip0", buildRenderPlan(plain, uri => uri), plain).join(";");
    expect(graph).not.toContain("drawbox");
    expect(graph.startsWith("[2:v]scale=320:180:force_original_aspect_ratio=decrease,format=rgba")).toBe(true);
    const proof = compositorVideoFilters({ ...input, clip: project.tracks[0].clips[0] }, "vclip0", buildRenderPlan(project, uri => uri), project).join(";");
    // Exact source crop, redaction, then ONE Lanczos resample to the viewport; no canvas fit, no pad, no layout crop on top.
    expect(proof.startsWith("[2:v]format=rgba,crop=320:180:0:0,drawbox=x=8:y=8:w=32:h=16:color=0xFFFFFF:t=fill:replace=1,scale=320:180:flags=lanczos,format=rgba")).toBe(true);
    expect(proof).not.toContain("force_original_aspect_ratio");
    expect(proof).not.toContain("pad=");
    expect(proof.match(/crop=/g)).toHaveLength(1);
    expect(proof.match(/scale=/g)).toHaveLength(1);
  }, 120000);

  it("keeps 1-px UI detail sharp: one resample from source pixels beats the old fit-then-crop double resample", async () => {
    const root = await temp.create("ps-"), width = 1280, height = 720;
    // Synthetic screenshot: white page, 1-px black/white line pairs (rows 180-359), and 5x7 one-pixel-stroke glyphs (rows 360-539).
    const raw = Buffer.alloc(width * height * 3, 255), set = (x: number, y: number) => raw.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
    for (let y = 180; y < 360; y++) for (let x = 320; x < 960; x += 2) set(x, y);
    const glyphs = ["11111100001111010000111111", "11110100101111010010111101", "10001100011111110001100011", "11111001000010000100001000"]
      .map(bits => bits.padEnd(35, "0"));
    for (let row = 0; row < 18; row++) for (let column = 0; column < 90; column++) {
      const glyph = glyphs[(row + column) % glyphs.length], ox = 320 + column * 7, oy = 360 + row * 10;
      for (let i = 0; i < 35; i++) if (glyph[i] === "1") set(ox + (i % 5), oy + Math.floor(i / 5));
    }
    const path = join(root, "ui-detail.png");
    const made = spawnSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", path],
      { windowsHide: true, timeout: 60000, input: raw });
    expect(made.status, made.stderr.toString()).toBe(0);
    const bytes = await readFile(path), canvas = { width: 640, height: 360 };
    const luma = (pixels: Buffer, x: number, y: number) => { const i = (y * 640 + x) * 3; return .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]; };
    /** Mean |horizontal + vertical luma gradient| over a box: line-pair contrast / high-frequency energy. */
    const energy = (pixels: Buffer, x0: number, y0: number, x1: number, y1: number) => {
      let sum = 0, count = 0;
      for (let y = y0; y < y1 - 1; y++) for (let x = x0; x < x1 - 1; x++) {
        sum += Math.abs(luma(pixels, x + 1, y) - luma(pixels, x, y)) + Math.abs(luma(pixels, x, y + 1) - luma(pixels, x, y)); count++;
      }
      return sum / count;
    };
    const measure = async (crop: ProofStillRectV1, name: string, lines: [number, number, number, number], glyphBox: [number, number, number, number]) => {
      const { project } = proofProject(path, bytes, canvas, { width, height }, crop, []);
      const old = structuredClone(project); delete old.tracks[0].clips[0].proofStill;
      const crisp = decodeFrame(await renderLossless(root, project, `${name}-crisp`), 2, "rgb24"), double = decodeFrame(await renderLossless(root, old, `${name}-old`), 2, "rgb24");
      return { crisp: { lines: energy(crisp, ...lines), glyphs: energy(crisp, ...glyphBox) }, old: { lines: energy(double, ...lines), glyphs: energy(double, ...glyphBox) } };
    };
    // 1:1 crop (640x360 source pixels into the 640x360 viewport): the new path is a pure crop.
    const oneToOne = await measure({ x: 320, y: 180, width: 640, height: 360 }, "one", [4, 4, 636, 176], [4, 184, 626, 356]);
    expect(oneToOne.crisp.lines).toBeGreaterThan(250);
    expect(oneToOne.crisp.lines).toBeGreaterThan(oneToOne.old.lines * 3);
    expect(oneToOne.crisp.glyphs).toBeGreaterThan(oneToOne.old.glyphs * 1.5);
    // A x0.8 viewport: still one resample versus x0.5 then x1.6.
    const scaled = await measure({ x: 240, y: 135, width: 800, height: 450 }, "scaled", [70, 40, 570, 176], [70, 184, 570, 350]);
    expect(scaled.crisp.glyphs).toBeGreaterThan(scaled.old.glyphs * 1.2);
    await writeFile(join(root, "sharpness.json"), JSON.stringify({ oneToOne, scaled }, null, 2));
    console.info("proof-still sharpness (mean |gradient| in 8-bit luma):", JSON.stringify({ oneToOne, scaled }));
  }, 240000);
});
