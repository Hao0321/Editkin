import { describe, expect, it } from "vitest";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AcesOutputTransform } from "../domain/types";
import type { VideoEncoder } from "./ffmpegTypes";
import { createDemoProject } from "../domain/demo";
import { buildRenderPlan } from "./planner";
import { encoderArgs, renderComposite } from "./ffmpegComposite";
import { outputColorMetadataArgs } from "./outputColorMetadata";

const rec709 = ["-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"];
const h264 = ["libx264", "h264_nvenc", "h264_videotoolbox"] as const;
const hevc = ["libx265", "hevc_nvenc", "hevc_videotoolbox"] as const;
const transforms = ["rec709_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const;

describe("output colour metadata arguments", () => {
  it.each(h264)("uses H.264 VUI with the actual %s encoder", (encoder) => {
    expect(outputColorMetadataArgs(encoder, "rec709_sdr")).toEqual([...rec709, "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"]);
  });
  it.each(hevc)("uses HEVC VUI with the actual %s encoder", (encoder) => {
    expect(outputColorMetadataArgs(encoder, "rec709_sdr")).toEqual([...rec709, "-bsf:v", "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"]);
  });
  it.each([...h264, ...hevc])("preserves HLG/PQ colour descriptions for %s", (encoder) => {
    const family = h264.includes(encoder as typeof h264[number]) ? "h264" : "hevc";
    expect(outputColorMetadataArgs(encoder, "rec2100_hlg_1000")).toEqual(["-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_trc", "arib-std-b67", "-bsf:v", `${family}_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9`]);
    expect(outputColorMetadataArgs(encoder, "rec2100_pq_1000")).toEqual(["-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_trc", "smpte2084", "-bsf:v", `${family}_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9`]);
  });
  it("never applies H.264/HEVC filters to ProRes", () => {
    for (const transform of transforms) {
      const args = outputColorMetadataArgs("prores_ks", transform);
      expect(args).toHaveLength(6);
      expect(args).not.toContain("-bsf:v");
      expect(args[5]).toBe(transform === "rec709_sdr" ? "bt709" : transform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084");
    }
  });
  it("keeps the pre-existing unmeasured P3 branch unchanged without adding Rec.709 VUI", () => {
    for (const encoder of [...h264, ...hevc, "prores_ks"] as const) expect(outputColorMetadataArgs(encoder, "p3d65_sdr")).toEqual(rec709);
  });
  it("does not fabricate full range, mastering data, or unsupported colour transforms", () => {
    for (const transform of transforms) expect(outputColorMetadataArgs("libx265", transform).join(" ")).not.toMatch(/full_range|color_range|master-display|max-cll|x265-params/);
    expect(() => outputColorMetadataArgs("libx264", "unknown" as AcesOutputTransform)).toThrow(/transform/);
    expect(() => outputColorMetadataArgs("not-h264" as VideoEncoder, "rec709_sdr")).toThrow(/encoder/);
  });
});

interface VideoProbe {
  codec_name?: string; width?: number; height?: number; pix_fmt?: string;
  color_primaries?: string; color_transfer?: string; color_space?: string;
  avg_frame_rate?: string; nb_read_frames?: string; duration?: string;
}
// Independent oracle: no production metadata helper is used to infer expected tags.
function assertColorDescription(probe: VideoProbe, codec: string, transform: typeof transforms[number]) {
  assert.equal(probe.codec_name, codec);
  assert.equal(probe.color_primaries, transform === "rec709_sdr" ? "bt709" : "bt2020");
  assert.equal(probe.color_space, transform === "rec709_sdr" ? "bt709" : "bt2020nc");
  assert.equal(probe.color_transfer, transform === "rec709_sdr" ? "bt709" : transform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084");
}
function assertProbe(probe: VideoProbe, codec: string, transform: typeof transforms[number]) {
  assertColorDescription(probe, codec, transform);
  assert.equal(probe.width, 160); assert.equal(probe.height, 90);
  assert.equal(probe.avg_frame_rate, "30/1"); assert.equal(probe.nb_read_frames, "30");
  assert(Math.abs(Number(probe.duration) - 1) < 0.05, "Missing/truncated duration");
  assert.equal(probe.pix_fmt, transform === "rec709_sdr" ? "yuv420p" : "yuv420p10le");
}

describe("independently decoded output colour metadata", () => {
  it("calibrates against missing, wrong-colour and malformed output observations", () => {
    const good: VideoProbe = { codec_name: "h264", width: 160, height: 90, pix_fmt: "yuv420p", color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", avg_frame_rate: "30/1", nb_read_frames: "30", duration: "1.0" };
    assertProbe(good, "h264", "rec709_sdr");
    const negatives: Partial<VideoProbe>[] = [
      { color_primaries: undefined }, { color_transfer: undefined }, { color_space: undefined },
      { color_primaries: "bt2020" }, { color_transfer: "arib-std-b67" }, { color_space: "bt2020nc" },
      { codec_name: "hevc" }, { width: 320 }, { height: 180 }, { avg_frame_rate: "24/1" },
      { nb_read_frames: "29" }, { duration: "0.5" }, { duration: undefined }, { pix_fmt: "yuv420p10le" },
    ];
    for (const patch of negatives) expect(() => assertProbe({ ...good, ...patch }, "h264", "rec709_sdr")).toThrow();
    const hlg = { ...good, codec_name: "hevc", pix_fmt: "yuv420p10le", color_primaries: "bt2020", color_transfer: "arib-std-b67", color_space: "bt2020nc" };
    assertProbe(hlg, "hevc", "rec2100_hlg_1000");
    expect(() => assertProbe({ ...hlg, color_transfer: "smpte2084" }, "hevc", "rec2100_hlg_1000")).toThrow();
    expect(() => assertProbe({ ...hlg, color_transfer: "bt709" }, "hevc", "rec2100_hlg_1000")).toThrow();
    expect(() => assertProbe(hlg, "hevc", "rec2100_pq_1000")).toThrow();
  });

  it("writes actual MP4 VUI without changing decoded pixels, and reaches the composite call site", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? `darwin-${process.arch}` : `linux-${process.arch}`;
    const suffix = process.platform === "win32" ? ".exe" : "";
    const ffmpeg = resolve(root, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
    const ffprobe = resolve(root, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
    const parent = resolve(root, ".rd/tmp"); await mkdir(parent, { recursive: true });
    const workspace = await mkdtemp(resolve(parent, "output-color-metadata-real-"));
    const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
    const records: unknown[] = [];
    const exec = promisify(execFile);
    async function command(executable: string, args: string[]) {
      const started = Date.now();
      try {
        const result = await exec(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        records.push({ executable, args, exit: 0, elapsedMs: Date.now() - started, ...result }); return result;
      } catch (error) {
        const failure = error as Error & { code?: unknown; stdout?: string; stderr?: string };
        records.push({ executable, args, exit: failure.code, elapsedMs: Date.now() - started, message: failure.message, stdout: failure.stdout, stderr: failure.stderr }); throw error;
      }
    }
    async function probe(path: string): Promise<VideoProbe> {
      return JSON.parse((await command(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_streams", "-of", "json", path])).stdout).streams[0];
    }
    async function frames(path: string) {
      const result = await command(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-an", "-f", "framemd5", "-"]);
      const rows = result.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
      expect(rows).toHaveLength(30);
      expect(rows.every((line) => /^[a-f0-9]{32}$/i.test(line.split(",").at(-1)!.trim()))).toBe(true);
      expect(new Set(rows.map((line) => line.split(",").at(-1)!.trim())).size).toBeGreaterThan(1);
      return rows;
    }
    async function elementaryProbe(path: string, codec: string) {
      const elementary = `${path}.${codec}`;
      await command(ffmpeg, ["-nostdin", "-n", "-v", "error", "-i", path, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", `${codec}_mp4toannexb`, "-f", codec, elementary]);
      const observed = await probe(elementary);
      return { path: elementary, sha256: await sha(elementary), probe: observed };
    }
    const artifacts: unknown[] = [];
    let status = "FAIL";
    try {
      const cases = [
        { encoder: "libx264", codec: "h264", transform: "rec709_sdr" },
        { encoder: "libx265", codec: "hevc", transform: "rec709_sdr" },
        { encoder: "libx265", codec: "hevc", transform: "rec2100_hlg_1000" },
        { encoder: "libx265", codec: "hevc", transform: "rec2100_pq_1000" },
      ] as const;
      let sdrSource = "";
      for (const { encoder, codec, transform } of cases) {
        const base = resolve(workspace, `${encoder}-${transform}-flags-only.mp4`);
        const output = resolve(workspace, `${encoder}-${transform}-vui.mp4`);
        const metadata = outputColorMetadataArgs(encoder, transform);
        const originalFlags = metadata.slice(0, metadata.indexOf("-bsf:v"));
        const common = ["-nostdin", "-n", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-an", ...encoderArgs(encoder), "-threads", "2", ...(encoder === "libx265" ? ["-x265-params", "pools=1:frame-threads=1"] : []), "-pix_fmt", transform === "rec709_sdr" ? "yuv420p" : "yuv420p10le"];
        await command(ffmpeg, [...common, ...originalFlags, base]);
        await command(ffmpeg, [...common, ...metadata, output]);
        const before = await probe(base), after = await probe(output);
        assertProbe(after, codec, transform);
        const elementary = await elementaryProbe(output, codec);
        assertColorDescription(elementary.probe, codec, transform);
        if (encoder === "libx264") {
          expect(() => assertProbe(before, codec, transform)).toThrow(); // The measured missing-tag defect.
          // An untagged source prevents inherited input tags from concealing a
          // disconnected production output helper in the composite check below.
          sdrSource = base;
        }
        const beforeFrames = await frames(base), afterFrames = await frames(output);
        expect(afterFrames).toEqual(beforeFrames); // Metadata is not a pixel transform.
        const wrong = resolve(workspace, `${encoder}-${transform}-wrong-transfer.mp4`);
        const wrongTransfer = transform === "rec2100_hlg_1000" ? 16 : 18;
        const wrongTransferName = wrongTransfer === 16 ? "smpte2084" : "arib-std-b67";
        // Change both the MP4 container declaration and VUI; container-only
        // probing can otherwise mask a conflicting elementary-stream value.
        await command(ffmpeg, ["-nostdin", "-n", "-v", "error", "-i", output, "-map", "0:v:0", "-c:v", "copy", "-color_trc", wrongTransferName, "-bsf:v", `${codec}_metadata=transfer_characteristics=${wrongTransfer}`, wrong]);
        const wrongProbe = await probe(wrong);
        expect(() => assertProbe(wrongProbe, codec, transform)).toThrow();
        const wrongElementary = await elementaryProbe(wrong, codec);
        expect(() => assertColorDescription(wrongElementary.probe, codec, transform)).toThrow();
        artifacts.push({ encoder, transform, base: { path: base, sha256: await sha(base), probe: before }, output: { path: output, sha256: await sha(output), probe: after, elementary }, negative: { path: wrong, sha256: await sha(wrong), probe: wrongProbe, elementary: wrongElementary, rejected: true }, decodedFrameCount: afterFrames.length, decodedSamplesEqual: true, frameRowsSha256: createHash("sha256").update(afterFrames.join("\n")).digest("hex") });
      }
      const project = createDemoProject(); project.width = 160; project.height = 90; project.fps = 30;
      project.assets[0].uri = sdrSource; project.assets[0].duration = 1; project.assets[0].width = 160; project.assets[0].height = 90;
      project.tracks[0].clips[0].duration = 1;
      const composite = resolve(workspace, "actual-composite.mp4");
      await renderComposite(ffmpeg, ffprobe, composite, project, buildRenderPlan(project, (uri) => uri), undefined, "libx264", 30000);
      const compositeProbe = await probe(composite); assertProbe(compositeProbe, "h264", "rec709_sdr");
      const compositeElementary = await elementaryProbe(composite, "h264"); assertColorDescription(compositeElementary.probe, "h264", "rec709_sdr");
      artifacts.push({ actualProductionComposite: true, path: composite, sha256: await sha(composite), probe: compositeProbe, elementary: compositeElementary, decodedFrameCount: (await frames(composite)).length });
      const prores = resolve(workspace, "actual-prores.mov");
      await command(ffmpeg, ["-nostdin", "-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-an", ...encoderArgs("prores_ks"), "-pix_fmt", "yuva444p10le", ...outputColorMetadataArgs("prores_ks", "rec709_sdr"), prores]);
      const proresProbe = await probe(prores); expect(proresProbe.codec_name).toBe("prores"); expect(proresProbe.nb_read_frames).toBe("30");
      artifacts.push({ path: prores, sha256: await sha(prores), probe: proresProbe, boundary: "Existing ProRes options still encode successfully; no H.264/HEVC filter used" });
      status = "PASS";
    } finally {
      const report = { schema: "editkin.output-color-metadata-test/v1", status, workspace, scope: "Actual synthetic encode + independent probe/full decode; NOT native-packaged/UI/appearance acceptance", input: "FFmpeg lavfi testsrc2=size=160x90:rate=30:duration=1", identities: { ffmpeg: await sha(ffmpeg), ffprobe: await sha(ffprobe), helper: await sha(resolve(root, "src/render/outputColorMetadata.ts")), composite: await sha(resolve(root, "src/render/ffmpegComposite.ts")), evaluator: await sha(fileURLToPath(import.meta.url)) }, artifacts, records, notChecked: ["hardware encoder execution", "real HDR appearance or mastering metadata", "P3 colour metadata repair", "native packaged app", "user footage or aesthetics", "release"] };
      await writeFile(resolve(workspace, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
      console.log("RETAINED_OUTPUT_COLOR_METADATA", workspace, status);
    }
  }, 120000);
});
