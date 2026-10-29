import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEmptyProject } from "../../domain/editGraph";
import { createPhoneProjectV1 } from "../../application/phoneProjectV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../../domain/types";
import { renderComposite } from "../ffmpegComposite";
import { buildRenderPlan } from "../planner";
import { PARITY_CANVAS_V1, parityFixtureProjectV1, paritySamplePointsV1, type ParityFixtureV1, type ParityImageNameV1 } from "./blendParityFixturesV1";
import { sampleParityPixelsV1, type ParityRendererV1, type ParityRgb8V1 } from "./blendParityHarnessV1";

const run = promisify(execFile);

/**
 * The export's ACES 2 phone input stage receives an 8-bit image as `format=gbrap16le` then `format=gbrpf32le`
 * (sourceColorFilters → display reconstruction). swscale's conversion is not exact (255 → about 0.9962) and not strictly
 * per channel, so this measures it for every pixel of each fixture image; the reference then feeds the display inverse
 * exactly what the export does. Alpha is measured on the 16-bit working plane (swscale maps 255 to 65532, so an
 * "opaque" layer is 99.995 % opaque there). Only this input decode is measured; blending and compositing are not.
 * Result: 4 values per pixel (R, G, B as the inverse receives them, alpha as the compositor uses it).
 */
export async function measureParityAcesInputDecodeV1(ffmpegPath: string, imagePaths: Record<ParityImageNameV1, string>): Promise<Record<ParityImageNameV1, Float32Array>> {
  const { width, height } = PARITY_CANVAS_V1, size = width * height;
  const decoded = {} as Record<ParityImageNameV1, Float32Array>;
  for (const [name, path] of Object.entries(imagePaths) as Array<[ParityImageNameV1, string]>) {
    const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", path, "-vf", "format=rgba,format=gbrap16le,format=gbrpf32le", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (stdout.length < size * 4 * 3) throw Error(`ACES input decode of ${name} too short`);
    const alpha = (await run(ffmpegPath, ["-v", "error", "-i", path, "-vf", "format=rgba,format=gbrap16le", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gbrap16le", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout;
    if (alpha.length < size * 8) throw Error(`ACES input alpha of ${name} too short`);
    const values = new Float32Array(size * 4);
    // gbrpf32le planes are G, B, R; gbrap16le plane 3 is alpha.
    for (let index = 0; index < size; index += 1) {
      values[index * 4] = stdout.readFloatLE((2 * size + index) * 4);
      values[index * 4 + 1] = stdout.readFloatLE(index * 4);
      values[index * 4 + 2] = stdout.readFloatLE((size + index) * 4);
      values[index * 4 + 3] = alpha.readUInt16LE((3 * size + index) * 2) / 65535;
    }
    decoded[name] = values;
  }
  return decoded;
}

/**
 * The export route: Editkin's real `renderComposite` (the FFmpeg graph every short export runs), FFV1 so the encode is
 * lossless, first frame decoded back to RGB. The reference picture goes through the same renderComposite as one
 * opaque normal image in a Rec.709 project, so both sides share the identical delivery stage (RGB → yuv420p); the
 * verdict compares the delivered yuv420p codes themselves at patch centres (decoding back to RGB would amplify one code
 * of rounding into up to three in blue), so it measures compositing only. Normal-only stacks of opaque full-canvas images are exact copies.
 * ACES 2 references are delivered as their ACEScct composite (16-bit PNG, interpretation "acescct" = identity input
 * LUT) through an ACES 2 phone project, i.e. through the export's own output LUT and float → yuv420p stage.
 */
export function createParityExportRendererV1(options: { ffmpegPath: string; ffprobePath: string; colorRoot?: string; timeoutMs?: number }): ParityRendererV1 {
  const timeoutMs = options.timeoutMs ?? 120_000;
  let sequence = 0;
  const { width, height } = PARITY_CANVAS_V1;
  /** First frame: decoded RGB (for reading) and the delivered yuv420p codes themselves (for the verdict). */
  const decode = async (path: string): Promise<{ rgb: ParityRgb8V1[]; ycbcr: ParityRgb8V1[] }> => {
    const frame = async (pixelFormat: string, bytes: number) => {
      const { stdout } = await run(options.ffmpegPath, ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", pixelFormat, "pipe:1"],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      if (stdout.length < bytes) throw Error(`decoded ${pixelFormat} frame too short: ${stdout.length}`);
      return stdout;
    };
    const rgb = sampleParityPixelsV1(await frame("rgb24", width * height * 3), width, 3);
    const yuv = await frame("yuv420p", width * height * 3 / 2), chroma = (width / 2) * (height / 2);
    const ycbcr = paritySamplePointsV1().map(({ x, y }) => {
      const c = (y >> 1) * (width / 2) + (x >> 1);
      return [yuv[y * width + x], yuv[width * height + c], yuv[width * height + chroma + c]] as const;
    });
    return { rgb, ycbcr };
  };
  const renderProject = async (project: ReturnType<typeof createEmptyProject>, directory: string, colorRoot?: string) => {
    const output = join(directory, `export-${sequence += 1}.mkv`);
    await renderComposite(options.ffmpegPath, options.ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", timeoutMs, undefined, colorRoot);
    return decode(output);
  };
  return {
    id: "export",
    route: "export:renderComposite(ffmpeg,ffv1)",
    async available() {
      if (!existsSync(options.ffmpegPath) || !existsSync(options.ffprobePath)) return { ok: false, reason: `FFmpeg not found: ${options.ffmpegPath}` };
      return { ok: true };
    },
    async render(fixture: ParityFixtureV1, context) {
      if (fixture.colour === "aces2-phone" && !options.colorRoot) return { kind: "declined", reason: "ACES 2 colour resources not provided" };
      const directory = join(context.workDirectory, "export");
      await mkdir(directory, { recursive: true });
      const project = parityFixtureProjectV1(fixture, image => context.imagePaths[image]);
      const measured = await renderProject(project, directory, fixture.colour === "aces2-phone" ? options.colorRoot : undefined);
      if (!context.referencePngPath) return { kind: "measured", samples: measured.rgb };
      // Same delivery stage for the reference picture: one opaque full-canvas image, normal blend, Rec.709.
      const { fps } = PARITY_CANVAS_V1;
      const aces = Boolean(context.referenceWorkingPngPath);
      const delivery = (aces ? createPhoneProjectV1 : createEmptyProject)("Parity reference delivery", { id: "parity-reference-delivery", width, height, fps });
      if (aces) delivery.colorManagement = { ...delivery.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
      delivery.assets.push({ id: "reference", name: "reference", uri: aces ? context.referenceWorkingPngPath! : context.referencePngPath, kind: "image", duration: 5, width, height,
        ...(aces ? { color: { interpretation: "acescct" as const } } : {}) });
      delivery.tracks[0].clips.push({ id: "reference", assetId: "reference", trackId: delivery.tracks[0].id, timelineStart: 0, sourceStart: 0,
        duration: PARITY_CANVAS_V1.duration, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
      const expected = await renderProject(delivery, directory, aces ? options.colorRoot : undefined);
      return { kind: "measured", samples: measured.rgb, expected: expected.rgb, compare: { space: "ycbcr", samples: measured.ycbcr, expected: expected.ycbcr } };
    },
  };
}
