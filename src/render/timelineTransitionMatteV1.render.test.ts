import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { aces16AlphaOverGraphV1 } from "./aces16AlphaCompositeV1";
import type { TransitionRgbaV1, TransitionWorkingEncodingV1 } from "./timelineTransitionMixV1";
import { timelineTransitionMatteMixV1, timelineTransitionMatteStreamV1, timelineTransitionQuantize16V1 } from "./timelineTransitionMatteV1";
import { timelineTransitionMatteCubeTextV1, timelineTransitionMatteLutSpecsV1, timelineTransitionMatteMixGraphV1, timelineTransitionNativeAlphaOverV1,
  type TimelineTransitionMatteLutsV1 } from "./timelineTransitionMatteNativeV1";

/** The native-filter FFmpeg matte kernel against the CPU reference on real 16-bit frames (all four planes, three encodings). */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), width = 196, height = 8, pixels = width * height, frames = 3;
const levels = [0, 1, 128, 16384, 32768, 49151, 65534, 65535];
const planes: Record<"a" | "b" | "m" | "o", Buffer> = { a: Buffer.alloc(pixels * 8 * frames), b: Buffer.alloc(pixels * 8 * frames), m: Buffer.alloc(pixels * 8 * frames), o: Buffer.alloc(pixels * 8 * frames) };
const value = (name: keyof typeof planes, f: number, plane: number, i: number) => planes[name].readUInt16LE(2 * ((f * 4 + plane) * pixels + i));
const spaces = ["linear", "acescct", "rec709_display"] as const;
const luts = {} as Record<TransitionWorkingEncodingV1, TimelineTransitionMatteLutsV1>;
/** Every 16-bit code once: a 256 × 256 ramp (plane offsets differ so planes are not identical). */
const RAMP = 256, RAMP_PIXELS = RAMP * RAMP;
let root: string;
beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `p3c-matte-kernel-${process.pid}`);
  await mkdir(root, { recursive: true });
  let seed = 99;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 65536;
  for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
    const x = i % width;
    const write = (name: keyof typeof planes, plane: number, code: number) => planes[name].writeUInt16LE(code, 2 * ((f * 4 + plane) * pixels + i));
    write("a", 3, levels[x % 8]); write("b", 3, levels[Math.floor(x / 8) % 8]);
    write("m", 3, levels[Math.floor(x / 64) % 8 === 7 ? 7 : (x + f) % 8]); write("o", 3, levels[(Math.floor(x / 3) + f) % 8]);
    for (let plane = 0; plane < 3; plane += 1) { write("a", plane, random()); write("b", plane, random()); write("m", plane, 65535); write("o", plane, random()); }
  }
  for (const name of Object.keys(planes) as Array<keyof typeof planes>) await writeFile(join(root, `${name}.raw`), planes[name]);
  for (const space of spaces) {
    const files: Record<string, string> = {};
    for (const spec of timelineTransitionMatteLutSpecsV1(space)) {
      files[spec.name] = join(root, `${space}-${spec.name}.cube`);
      await writeFile(files[spec.name], timelineTransitionMatteCubeTextV1(spec));
    }
    luts[space] = { space, files };
  }
  // Code ramps for the exact passthrough checks: every code in every colour plane, alpha 65535 (and a ramp for alpha).
  const ramp = (offset: number, alphaRamp: boolean) => {
    const bytes = Buffer.alloc(RAMP_PIXELS * 8);
    for (let plane = 0; plane < 4; plane += 1) for (let i = 0; i < RAMP_PIXELS; i += 1) {
      bytes.writeUInt16LE(plane === 3 ? (alphaRamp ? (i * 7 + offset) % 65536 : 65535) : (i * (plane * 2 + 1) + offset) % 65536, 2 * (plane * RAMP_PIXELS + i));
    }
    return bytes;
  };
  await writeFile(join(root, "ramp-a.raw"), ramp(0, true)); await writeFile(join(root, "ramp-b.raw"), ramp(12345, true));
  await writeFile(join(root, "ramp-o.raw"), ramp(777, false));
  const matte = (code: number) => { const bytes = Buffer.alloc(RAMP_PIXELS * 8); for (let i = 0; i < RAMP_PIXELS * 4; i += 1) bytes.writeUInt16LE(code, 2 * i); return bytes; };
  await writeFile(join(root, "matte-0.raw"), matte(0)); await writeFile(join(root, "matte-1.raw"), matte(65535));
  const clear = Buffer.alloc(RAMP_PIXELS * 8); await writeFile(join(root, "clear.raw"), clear);
  await writeFile(join(root, "zero.raw"), Buffer.alloc(pixels * 8 * frames));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("matte stream on the composite clock", () => {
  it("emits only the window: matte frame k at project frame startFrame + k, alpha at full 16-bit scale", async () => {
    const tiny = 8, durationFrames = 15, startFrame = 23, total = 60, raw = Buffer.alloc(durationFrames * tiny * tiny * 8);
    for (let k = 0; k < durationFrames; k += 1) for (let i = 0; i < tiny * tiny; i += 1) raw.writeUInt16LE((k + 1) * 4000, 2 * ((k * 4 + 3) * tiny * tiny + i));
    await writeFile(join(root, "matte-clock.raw"), raw);
    const graph = `${timelineTransitionMatteStreamV1(0, "m", { startFrame, durationFrames }, { fps: 30, duration: total / 30 })};[m]alphaextract[o]`;
    const run = (format: string[]) => runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${tiny}x${tiny}`, "-framerate", "30",
      "-i", join(root, "matte-clock.raw"), "-filter_complex", graph, "-map", "[o]", "-fps_mode", "passthrough", ...format], total * tiny * tiny * 2 + 65536, 30_000);
    const bytes = (await run(["-f", "rawvideo", "-pix_fmt", "gray16le", "pipe:1"])).stdout;
    expect(bytes.length).toBe(durationFrames * tiny * tiny * 2);
    for (let k = 0; k < durationFrames; k += 1) {
      const code = (k + 1) * 4000; // 12-bit-to-16-bit bit replication adds floor(code / 4096)
      for (let i = 0; i < tiny * tiny; i += 1) expect({ k, alpha: bytes.readUInt16LE(2 * (k * tiny * tiny + i)) }).toEqual({ k, alpha: code + Math.floor(code / 4096) });
    }
    // Timestamps: one frame per project tick, starting at startFrame (time base 1/30).
    const crc = (await run(["-c:v", "rawvideo", "-pix_fmt", "gray16le", "-f", "framecrc", "pipe:1"])).stdout.toString("utf8");
    const pts = crc.split(/\r?\n/).filter(line => /^\d+,/.test(line)).map(line => Number(line.split(",")[1]));
    expect(crc).toMatch(/#tb 0: 1\/30/);
    expect(pts).toEqual(Array.from({ length: durationFrames }, (_, k) => startFrame + k));
  }, 60_000);
});

const input = (name: string, w = width, h = height) => ["-f", "rawvideo", "-pixel_format", "gbrap16le", "-video_size", `${w}x${h}`, "-framerate", "30", "-i", join(root, `${name}.raw`)];
const cases = spaces.flatMap(space => [true, false].map(overlay => ({ space, overlay })));

describe("actual 16-bit native-filter FFmpeg matte kernel", () => {
  it.each(cases)("$space overlay=$overlay matches the CPU reference on every plane", async ({ space, overlay }: { space: TransitionWorkingEncodingV1; overlay: boolean }) => {
    const names = overlay ? ["a", "b", "m", "o"] : ["a", "b", "m"];
    const graph = `${names.map((name, index) => `[${index}:v]format=gbrap16le[${name}]`).join(";")};`
      + timelineTransitionMatteMixGraphV1("a", "b", "m", overlay ? "o" : undefined, "out", luts[space]).join(";");
    const bytes = (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", ...names.flatMap(name => input(name)), "-filter_complex", graph, "-map", "[out]",
      "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 60_000)).stdout;
    expect(bytes.length).toBe(pixels * 8 * frames);
    let alphaError = 0, rgbError = 0, witness = {}, mixed = 0, exact = 0, rgbChecked = 0, alphaExact = 0, alphaChecked = 0, alphaWitness = {};
    for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
      const pixel = (name: "a" | "b" | "o"): TransitionRgbaV1 => [0, 1, 2, 3].map(plane => value(name, f, plane, i) / 65535) as unknown as TransitionRgbaV1;
      const m = value("m", f, 3, i) / 65535;
      const expected = timelineTransitionMatteMixV1(pixel("a"), pixel("b"), m, overlay ? pixel("o") : undefined, space);
      if (m > 0 && m < 1) mixed += 1;
      for (let plane = 0; plane < 4; plane += 1) {
        const actual = bytes.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)), want = timelineTransitionQuantize16V1(expected[plane]);
        const error = Math.abs(actual - want);
        if (plane === 3) { alphaChecked += 1; if (error === 0) alphaExact += 1; if (error > alphaError) { alphaError = error; alphaWitness = { f, i, actual, want, m, a: pixel("a")[3], b: pixel("b")[3], o: overlay ? pixel("o")[3] : 0 }; } }
        else { rgbChecked += 1; if (error === 0) exact += 1; if (error > rgbError) { rgbError = error; witness = { f, i, plane, actual, want, m, a: pixel("a"), b: pixel("b") }; } }
      }
    }
    // The kernel runs in float32 (as the WGSL shader does); the reference rounds a double. Off-by-one codes are float32
    // rounding at near-ties, which this fixture provokes on purpose (alpha levels 1, 65534, 32768 ...).
    console.log(JSON.stringify({ space, overlay, mixed, rgbError, rgbExact: exact / rgbChecked, alphaError, alphaExact: alphaExact / alphaChecked, alphaWitness }));
    expect(mixed).toBeGreaterThan(pixels);
    expect(alphaError, JSON.stringify(alphaWitness)).toBeLessThanOrEqual(1);
    expect(rgbError, JSON.stringify(witness)).toBeLessThanOrEqual(1);
    expect(exact / rgbChecked).toBeGreaterThan(0.99);
    expect(alphaExact / alphaChecked).toBeGreaterThan(0.95);
  }, 120_000);

  it.each(spaces)("%s: every 16-bit code passes through exactly at m = 0, m = 1 and under an opaque overlay", async (space: TransitionWorkingEncodingV1) => {
    const run = async (names: string[], overlay: boolean) => {
      const graph = `${names.map((name, index) => `[${index}:v]format=gbrap16le[i${index}]`).join(";")};`
        + timelineTransitionMatteMixGraphV1("i0", "i1", "i2", overlay ? "i3" : undefined, "out", luts[space]).join(";");
      return (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", ...names.flatMap(name => input(name, RAMP, RAMP)), "-filter_complex", graph, "-map", "[out]",
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], RAMP_PIXELS * 8, 60_000)).stdout;
    };
    const read = (name: string) => readFile(join(root, `${name}.raw`));
    const [a, b, o] = await Promise.all(["ramp-a", "ramp-b", "ramp-o"].map(read));
    const zeroAlpha = (bytes: Buffer) => { const copy = Buffer.from(bytes); for (let i = 0; i < RAMP_PIXELS; i += 1) if (copy.readUInt16LE(2 * (3 * RAMP_PIXELS + i)) === 0) for (let p = 0; p < 3; p += 1) copy.writeUInt16LE(0, 2 * (p * RAMP_PIXELS + i)); return copy; };
    // m = 0 → A; m = 1 → B (zero coverage reads as transparent black, as in the reference); opaque overlay → overlay.
    expect((await run(["ramp-a", "ramp-b", "matte-0"], false)).equals(zeroAlpha(a))).toBe(true);
    expect((await run(["ramp-a", "ramp-b", "matte-1"], false)).equals(zeroAlpha(b))).toBe(true);
    expect((await run(["ramp-a", "ramp-b", "matte-0", "ramp-o"], true)).equals(o)).toBe(true);
    expect((await run(["ramp-a", "ramp-b", "matte-1", "clear"], true)).equals(zeroAlpha(b))).toBe(true);
  }, 120_000);
});

describe("native straight-alpha source-over", () => {
  it.each(["normal", "multiply", "screen"])("%s matches the 16-bit geq source-over within one code (normal: exactly where the foreground is opaque)", async (mode: string) => {
    const graph = (over: string[]) => `[0:v]format=gbrap16le[base];[1:v]format=gbrap16le[fg];${over.join(";")}`;
    const render = async (over: string[]) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", ...input("a"), ...input("o"), "-filter_complex", graph(over),
      "-map", "[out]", "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 60_000)).stdout;
    const reference = await render(aces16AlphaOverGraphV1("base", "fg", "out", mode)), native = await render(timelineTransitionNativeAlphaOverV1("base", "fg", "out", mode));
    let maximum = 0, opaqueDifferences = 0, differences = 0;
    for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
      const fgOpaque = value("o", f, 3, i) === 65535;
      for (let plane = 0; plane < 4; plane += 1) {
        const at = 2 * ((f * 4 + plane) * pixels + i), error = Math.abs(native.readUInt16LE(at) - reference.readUInt16LE(at));
        maximum = Math.max(maximum, error); if (error) { differences += 1; if (fgOpaque) opaqueDifferences += 1; }
      }
    }
    console.log(JSON.stringify({ mode, maximum, differences, samples: frames * pixels * 4, opaqueDifferences }));
    expect(maximum).toBeLessThanOrEqual(1);
    // Normal mode passes an opaque foreground through untouched; a blend mode mixes its colour first.
    if (mode === "normal") expect(opaqueDifferences).toBe(0);
    expect(differences / (frames * pixels * 4)).toBeLessThan(0.03);
  }, 120_000);
});

describe("native source-over against the straight-alpha equation, stacked, and feeding the kernel", () => {
  const run = async (names: string[], graph: string) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", ...names.flatMap(name => input(name)),
    "-filter_complex", `${names.map((name, index) => `[${index}:v]format=gbrap16le[${name}]`).join(";")};${graph}`, "-map", "[out]", "-frames:v", String(frames),
    "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], pixels * 8 * frames, 60_000)).stdout;
  it("is within one code of colour = (F·af + B·ab·(1-af)) / a, a = af + ab·(1-af), and exact where the foreground is opaque", async () => {
    const out = await run(["a", "o"], timelineTransitionNativeAlphaOverV1("a", "o", "out").join(";"));
    let maximum = 0, opaqueMaximum = 0;
    for (let f = 0; f < frames; f += 1) for (let i = 0; i < pixels; i += 1) {
      const af = value("o", f, 3, i) / 65535, ab = value("a", f, 3, i) / 65535, alpha = af + ab * (1 - af);
      for (let plane = 0; plane < 4; plane += 1) {
        const want = plane === 3 ? Math.floor(alpha * 65535 + .5)
          : alpha === 0 ? 0 : Math.floor(Math.max(0, Math.min(65535, (value("o", f, plane, i) * af + value("a", f, plane, i) * ab * (1 - af)) / alpha)) + .5);
        const error = Math.abs(out.readUInt16LE(2 * ((f * 4 + plane) * pixels + i)) - want);
        maximum = Math.max(maximum, error); if (af === 1) opaqueMaximum = Math.max(opaqueMaximum, error);
      }
    }
    expect(maximum).toBeLessThanOrEqual(1); expect(opaqueMaximum).toBe(0);
  }, 60_000);
  it("passes a semi-transparent stack through a hidden layer and through the kernel at m = 0 unchanged", async () => {
    // FFmpeg 8 frames carry an alpha mode; without re-declaring straight alpha, the second premultiply was skipped.
    const first = await run(["zero", "a"], timelineTransitionNativeAlphaOverV1("zero", "a", "out").join(";"));
    const hidden = await run(["zero", "a", "o"], [...timelineTransitionNativeAlphaOverV1("zero", "a", "mid"), "[o]colorchannelmixer=aa=0[gone]",
      ...timelineTransitionNativeAlphaOverV1("mid", "gone", "out")].join(";"));
    expect(hidden.equals(first)).toBe(true);
    const kernel = await run(["zero", "a", "b"], ["[zero]split=3[clear][base][matte]", ...timelineTransitionNativeAlphaOverV1("clear", "a", "mid"),
      ...timelineTransitionNativeAlphaOverV1("base", "b", "other"), ...timelineTransitionMatteMixGraphV1("mid", "other", "matte", undefined, "out", luts.acescct)].join(";"));
    expect(kernel.equals(first)).toBe(true);
  }, 60_000);
});
