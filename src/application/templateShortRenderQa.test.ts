import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileTemplateShortFixture } from "./templateShortFixtures";
import { R3_STALL, R4_JUMP, SHORTS_TEXT_COLUMN, TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA, analyzeRenderedShort, detectRenderedMotion,
  templateShortQaTools, templateShortRenderExpectations, type TemplateShortRenderExpectations } from "./templateShortQa";

// M1 wave 3 step 3.1: the render-time pixel gate. Media here is generated on the fly (2 s at 216×384) and deleted after;
// the T01 calibration replays a stored band series measured on the real r53b render (fixtures/t01-r53b).
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ffmpeg = templateShortQaTools().ffmpeg;
const T01_SERIES = resolve(".rd/benchmarks/usable-v1-20261009/fixtures/t01-r53b/rendered-band-series.json");
// 2 s of 216×384 gray frames written frame by frame (exact positions) and encoded with a tone: a 24×48 white box on black
// moving 3 px a frame along y 150 (x = 3k), which holds at frame 20 (x(20) = x(19)) and teleports 30 px at frame 40.
// `blackFirst` leaves frame 0 entirely black.
const W = 216, H = 384;
const boxX = (frame: number) => frame === 20 ? 57 : frame >= 40 ? 3 * frame + 30 : 3 * frame;
function synthetic(path: string, blackFirst = false) {
  return new Promise<void>((done, fail) => {
    const child = spawn(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast",
      "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", fail);
    child.on("close", code => code === 0 ? done() : fail(new Error(`ffmpeg ${code}: ${stderr.slice(-500)}`)));
    for (let frame = 0; frame < 60; frame++) {
      const pixels = Buffer.alloc(W * H);
      if (!(blackFirst && frame === 0)) for (let y = 150; y < 198; y++) for (let x = boxX(frame); x < Math.min(W, boxX(frame) + 24); x++) pixels[y * W + x] = 255;
      child.stdin.write(pixels);
    }
    child.stdin.end();
  });
}
/** What the synthetic box was authored to do: 3 px a frame from frame 1 to 59, inside one band. */
const boxExpectations = (authoredJumpAt?: number): TemplateShortRenderExpectations => ({
  schema: TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA, width: W, height: H, fps: 30, startFrame: 0, durationFrames: 60,
  bands: [{ id: "probe:box#0", role: "probe:box", group: "probe:box", text: "■", box: [0, 140, W, 208],
    motion: [[1, Array.from({ length: 59 }, (_, index) => index + 1 === authoredJumpAt ? 33 : 3)]] }],
  firstFrameText: [0, 130, 60, 218], textColumn: [],
});

let folder = "";
beforeAll(async () => { folder = await mkdtemp(join(tmpdir(), "editkin-render-qa-")); });
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

describe("render-time pixel gate on a real 2 s encode", () => {
  it("writes QA.json bound to the candidate SHA, passes R1 and finds the held frame (R3) and the teleport (R4)", async () => {
    const candidate = join(folder, "moving.mp4"), qaPath = join(folder, "qa", "QA.json");
    await synthetic(candidate);
    const analysis = await analyzeRenderedShort(candidate, boxExpectations(), 60, { qaPath, sheetsDir: join(folder, "qa", "scan"), report: { shortId: "ts-test" } });
    const bytes = await readFile(candidate), qa = JSON.parse(await readFile(qaPath, "utf8"));
    expect(qa).toMatchObject({ schema: "editkin.template-short-qa/v1", candidateSha256: sha(bytes), shortId: "ts-test", technical: { pass: true } });
    expect(analysis.candidateSha256).toBe(sha(bytes));
    expect(analysis.technical.checks.map(check => [check.id, check.pass])).toEqual([["R1_streams", true], ["R1_raster", true], ["R1_frame_rate", true],
      ["R1_duration", true], ["R1_frames", true], ["R1_decode", true], ["R1_bytes_unchanged", true]]);
    expect(analysis.flags.map(flag => [flag.id, flag.frames])).toEqual([["R3_stall", [20]], ["R4_jump", [40]]]);
    expect(analysis.flags[0].seconds).toEqual([0.67]);
    expect(analysis.sheets).toEqual(["sheet_01.jpg"]);
    expect(qa.renderedFlags).toHaveLength(2);
    // A jump the template itself authors (an exact cut) is a design choice, not a render defect.
    expect((await analyzeRenderedShort(candidate, boxExpectations(40), 60)).flags.map(flag => flag.id)).toEqual(["R3_stall"]);
    // The wrong frame count is a technical failure (never delivered).
    const short = await analyzeRenderedShort(candidate, boxExpectations(), 61);
    expect(short.technical.pass).toBe(false);
    expect(short.technical.checks.find(check => check.id === "R1_frames")).toMatchObject({ pass: false, detail: "解碼 60 格（應為 61）" });
  }, 120_000);

  it("flags a black first frame (R2)", async () => {
    const candidate = join(folder, "black-first.mp4");
    await synthetic(candidate, true);
    const analysis = await analyzeRenderedShort(candidate, boxExpectations(), 60);
    expect(analysis.technical.pass).toBe(true);
    expect(analysis.flags.find(flag => flag.id === "R2_first_frame")).toMatchObject({ severity: "FLAG", frames: [0], seconds: [0] });
    expect(analysis.measured.firstFrameSigma).toBeLessThanOrEqual(1);
  }, 120_000);
});

describe("R3/R4 calibration on the real T01 r53b render", () => {
  it.skipIf(!existsSync(T01_SERIES))("flags the f111 tag hold and nothing else in 330 frames", async () => {
    const fixture = JSON.parse(await readFile(T01_SERIES, "utf8"));
    expect(fixture.sources.outputSha256).toBe("e13b9b41d0fbac2bbffa5e855895b201e8b26e7cefa595cf51a9aec8233f0721");
    expect(fixture.series.frames).toBe(330);
    const { stalls, jumps } = detectRenderedMotion(fixture.expectations, fixture.series);
    expect(stalls.map(flag => [flag.id, flag.role, flag.frames])).toEqual([["R3_stall", "tag", [111]]]);
    expect(jumps).toEqual([]);
    // The calibration is not a coincidence of thresholds: the held frame is ~0 and its neighbours move well above R3's floor.
    const tag = fixture.expectations.bands.find((band: { group: string; motion: unknown[] }) => band.group === "tag" && band.motion.length);
    const d = fixture.series.bands[tag.id];
    expect(d[111]).toBeLessThanOrEqual(R3_STALL.held);
    expect(Math.min(d[110], d[112])).toBeGreaterThan(R3_STALL.neighbour);
    expect(R4_JUMP.ratio).toBeGreaterThan(R4_JUMP.authoredRatio);
  });
});

describe("render expectations of today's trip_pop_v1 compiles", () => {
  it.each(["strike_reframe", "context_stack"] as const)("%s: every text unit has a band on the canvas and the ink stays in the text column", async family => {
    const { project, packet } = await compileTemplateShortFixture(family);
    const expectations = templateShortRenderExpectations(packet, project);
    expect(expectations).toMatchObject({ width: 1080, height: 1920, fps: 30, startFrame: 0, durationFrames: packet.instance.input.durationFrames });
    const texts = packet.commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.text ? [command.graphic.id] : []);
    const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    for (const id of texts) expect(expectations.bands.some(band => band.role === roles.get(id))).toBe(true);
    for (const band of expectations.bands) {
      expect(band.box[0]).toBeGreaterThanOrEqual(0); expect(band.box[2]).toBeLessThanOrEqual(1080);
      expect(band.box[1]).toBeGreaterThanOrEqual(0); expect(band.box[3]).toBeLessThanOrEqual(1920);
    }
    expect(expectations.textColumn).toEqual([]);
    expect(expectations.firstFrameText).toBeDefined();
    expect(SHORTS_TEXT_COLUMN).toEqual({ left: 90, right: 930, top: 260, bottom: 1660 });
  }, 120_000);
});
