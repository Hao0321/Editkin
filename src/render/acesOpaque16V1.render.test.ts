import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { aces16ImageFilterChainsV1 } from "./aces16ImageFiltersV1";
import { aces16PositionedLayerGraphV1 } from "./acesOpaque16V1";
const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ff = join(app, "vendor/ffmpeg", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const width = 32, height = 16, pixels = width * height, frames = 3;
const frame = Buffer.alloc(pixels * 8);
for (let p = 0; p < 4; p++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) frame.writeUInt16LE(p === 3 ? 65535 : 20000 + p * 800 + x * 3 + y * 2, 2 * (p * pixels + y * width + x));
let work = "", raw = "", count = 0;
beforeAll(async () => { await readFile(ff); work = await mkdtemp(join(tmpdir(), "editkin-aces16-test-")); raw = join(work, "source.gbrap16le"); await writeFile(raw, Buffer.concat(Array(frames).fill(frame)), { flag: "wx" }); });
afterAll(async () => { if (!work) return; expect(dirname(work)).toBe(resolve(tmpdir())); await rm(work, { recursive: true, force: true }); });
async function render(graph: string, outputFrames = frames): Promise<Buffer> {
  const script = join(work, `${count++}.graph.txt`); await writeFile(script, graph, { flag: "wx" });
  const r = await runColorProcess(ff, ["-v", "error", "-nostdin", "-threads", "1", "-filter_complex_threads", "1", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", raw, "-filter_complex_script", script, "-map", "[out]", "-frames:v", String(outputFrames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * outputFrames, 10000);
  expect(r.stdout.length).toBe(pixels * 8 * outputFrames); return r.stdout;
}
const image = (filters: string[]) => ["[0:v]format=gbrap16le[src]", ...aces16ImageFilterChainsV1("src", "out", filters, "fx")].join(";");
const at = (b: Buffer, x: number, y: number, p = 0, f = 0) => b.readUInt16LE(f * frame.length + 2 * (p * pixels + y * width + x));
describe("actual bundled FFmpeg retains16-bit image and placement planes", () => {
  it.each(["linear", "cubic"])("identity %s perspective keeps every16-bit RGB and alpha code exact", async interpolation => {
    const bytes = await render(image([`perspective=sense=destination:interpolation=${interpolation}:eval=frame`]));
    expect(bytes).toEqual(Buffer.concat(Array(frames).fill(frame)));
  });
  it.each(["source", "destination"])("uses the correct %s homography direction", async sense => {
    const b = await render(image([`perspective=x0=4:x1=W+4:x2=4:x3=W+4:sense=${sense}:interpolation=linear`]));
    const sx = sense === "source" ? 16 : 8; expect(at(b, 12, 8)).toBe(at(frame, sx, 8)); expect(at(b, 12, 8, 3)).toBe(65535);
  });
  it("uses one-based corner clocks at each actual frame", async () => {
    const b = await render(image(["perspective=x0=on:x1=W+on:x2=on:x3=W+on:sense=source:interpolation=linear:eval=frame"]));
    for (let f = 0; f < frames; f++) expect(at(b, 8, 8, 0, f)).toBe(at(frame, 9 + f, 8));
  });
  it.each(["eq=brightness=0:contrast=1:saturation=1:eval=frame", "hue=h=0"])("preserves narrow colour levels and opaque alpha through %s", async filter => {
    const b = await render(image([filter]));
    expect(new Set(Array.from({ length: width }, (_, x) => at(b, x, 8))).size).toBe(width);
    for (let p = 0; p < 4; p++) for (let i = 0; i < pixels; i++) expect(Math.abs(b.readUInt16LE(2 * (p * pixels + i)) - frame.readUInt16LE(2 * (p * pixels + i)))).toBeLessThanOrEqual(p === 3 ? 0 : 4);
  });
  it("disabled eq leaves the first frame byte-exact and adjusts the following frames", async () => {
    const b = await render(image(["eq=brightness=.1:eval=frame:enable=gt(t,0)"]));
    expect(b.subarray(0, frame.length)).toEqual(frame); expect(at(b, 8, 8, 0, 1)).toBeGreaterThan(at(frame, 8, 8) + 6000);
  });
  it.each([false, true])("drawing replace=%s changes only the box and preserves outside alpha and narrow RGB", async replace => {
    const b = await render(image([`drawbox=x=8:y=4:w=8:h=4:color=red@.5:t=fill${replace ? ":replace=1" : ""}`]));
    for (let p = 0; p < 4; p++) expect(at(b, 2, 2, p)).toBe(at(frame, 2, 2, p));
    expect(at(b, 10, 5, 2)).toBeGreaterThan(at(frame, 10, 5, 2));
    if (replace) expect(at(b, 10, 5, 3)).toBeGreaterThan(32000); else expect(at(b, 10, 5, 3)).toBe(65535);
  });
  it("invert drawing preserves the separate photograph outside coverage", async () => {
    const b = await render(image(["drawbox=x=8:y=4:w=8:h=4:color=invert:t=fill"]));
    for (let p = 0; p < 4; p++) expect(at(b, 2, 2, p)).toBe(at(frame, 2, 2, p));
    expect(Math.abs(at(b, 10, 5) - (65535 - at(frame, 10, 5)))).toBeLessThanOrEqual(1);
  });
  it("delayed placement retains exact transparent gaps, project ticks and pixel coordinates", async () => {
    const project = createEmptyProject("Physical placement", { width, height, fps: 30 });
    const clip: TimelineClip = { id: "c", trackId: project.tracks[0].id, assetId: "a", timelineStart: 2 / 30, sourceStart: 0, duration: 1 / 30, volume: 0, transform: { ...DEFAULT_TRANSFORM, x: 2 }, color: { ...DEFAULT_COLOR }, keyframes: [] };
    const plan = { width, height, fps: 30, duration: 5 / 30 };
    const b = await render(["[0:v]trim=end_frame=1,format=gbrap16le[src]", ...aces16PositionedLayerGraphV1("src", "out", clip, plan, project)].join(";"), 5);
    for (const f of [0, 1, 3, 4]) for (let p = 0; p < 4; p++) expect(at(b, 10, 8, p, f)).toBe(0);
    expect(at(b, 10, 8, 0, 2)).toBe(at(frame, 8, 8)); expect(at(b, 10, 8, 3, 2)).toBe(65535); expect(at(b, 0, 8, 3, 2)).toBe(0);
  });
});
