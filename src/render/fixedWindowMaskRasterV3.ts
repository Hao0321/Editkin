import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { compileClipAlphaPlan, type ClipAlphaVectorOperation } from "../domain/clipAlphaPlan";
import type { EditProject, TimelineClip } from "../domain/types";
import { assertRenderActive, renderLifetimeSignal } from "./renderLifetime";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { maskOperationFeatherSigma } from "./maskFilters";

const rounded = (value: number) => Number(value.toFixed(5));
// This is an optimization limit. Larger planes retain the existing bounded GEQ path.
const MAX_RASTER_BYTES = 128 * 1024 * 1024;

/** The same rounded operands, half-open crossings and integer truncation as maskFilters GEQ. */
export function fixedWindowMaskRasterV3(operation: ClipAlphaVectorOperation, frame: number, width: number, height: number, maximum: 255 | 65535 = 255, bigEndian = false): Buffer {
  if (!operation.fixedWindowV3 || operation.kind !== "polygon" || !Number.isInteger(frame) || frame < 0 || frame >= operation.samples.length
    || ![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid fixed-window raster input");
  const bytesPerPixel = maximum === 255 ? 1 : 2, size = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(size) || size > MAX_RASTER_BYTES) throw new Error("Fixed-window raster exceeds optimization memory limit");
  const output = Buffer.alloc(size), original = operation.samples[frame].points;
  if (!original) return output;
  const cx = original.reduce((sum, point) => sum + point.x, 0) / original.length;
  const cy = original.reduce((sum, point) => sum + point.y, 0) / original.length;
  const scale = Math.max(.05, 1 + (operation.expansion + operation.edgeShift) * 2);
  const path = original.map(point => ({
    x: Math.max(0, Math.min(1, cx + (point.x - cx) * scale)) * width,
    y: Math.max(0, Math.min(1, cy + (point.y - cy) * scale)) * height,
  }));
  const edges = path.map((point, index) => {
    const next = path[(index + 1) % path.length], dy = next.y - point.y;
    return { minY: rounded(Math.min(point.y, next.y)), maxY: rounded(Math.max(point.y, next.y)),
      x: rounded(point.x), y: rounded(point.y), dx: rounded(next.x - point.x), dy: rounded(Math.abs(dy) < .00001 ? .00001 : dy) };
  });
  const value = Math.trunc(maximum * rounded(operation.opacity)), white = Buffer.alloc(bytesPerPixel), zero = Buffer.alloc(bytesPerPixel);
  if (bytesPerPixel === 1) white[0] = value;
  else if (bigEndian) white.writeUInt16BE(value);
  else white.writeUInt16LE(value);
  if (operation.inverted) output.fill(white);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) assertRenderActive();
    const crossings = edges.filter(edge => y > edge.minY && y <= edge.maxY)
      .map(edge => edge.x + (y - edge.y) * edge.dx / edge.dy).sort((left, right) => left - right);
    if (crossings.length % 2 !== 0) throw new Error("Invalid fixed-window polygon crossings");
    for (let index = 0; index < crossings.length; index += 2) {
      const from = Math.max(0, Math.min(width, Math.ceil(crossings[index])));
      const to = Math.max(0, Math.min(width, Math.ceil(crossings[index + 1])));
      if (to > from) output.fill(operation.inverted ? zero : white, (y * width + from) * bytesPerPixel, (y * width + to) * bytesPerPixel);
    }
  }
  return output;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 4, "ascii"); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

/** Lossless grayscale PNG; 16-bit samples are network-endian as required by PNG. */
export function fixedWindowMaskPngV3(operation: ClipAlphaVectorOperation, frame: number, width: number, height: number, maximum: 255 | 65535 = 255): Buffer {
  const raster = fixedWindowMaskRasterV3(operation, frame, width, height, maximum, true), stride = width * (maximum === 255 ? 1 : 2);
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) raster.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = maximum === 255 ? 8 : 16;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]);
}

export interface FixedWindowMaskPlaneV3 { maskId: string; pattern: string; frameCount: number }
export interface PreparedFixedWindowMaskPlanesV3 {
  workDirectory?: string;
  planesByClip: ReadonlyMap<string, readonly FixedWindowMaskPlaneV3[]>;
}

/** Explicit v3 only. Feather and authored stack/source-alpha operations remain in FFmpeg. */
export async function prepareFixedWindowMaskPlanesV3(project: EditProject, clips: readonly TimelineClip[], maximum: 255 | 65535 = 255): Promise<PreparedFixedWindowMaskPlanesV3> {
  const planesByClip = new Map<string, FixedWindowMaskPlaneV3[]>();
  const marked = clips.filter(clip => clip.masks?.some(mask => mask.enabled && mask.fixedWindowV3));
  if (!marked.length) return { planesByClip };
  assertRenderActive();
  const bytes = project.width * project.height * (maximum === 255 ? 1 : 2);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RASTER_BYTES) return { planesByClip };
  let workDirectory: string | undefined;
  try {
    for (const [clipIndex, clip] of marked.entries()) {
      if (planesByClip.has(clip.id)) continue;
      const plan = compileClipAlphaPlan(project, clip, "formal");
      const hasFeather = plan.operations.some(operation => maskOperationFeatherSigma(operation, project.width, project.height) > .1);
      // The hard-mask fast path combines floating opacities before quantizing.
      // Retain it for fractional values; binary stacks have identical rounding.
      if (!hasFeather && plan.operations.some(operation => operation.source !== "vector" || ![0, 1].includes(rounded(operation.opacity)))) continue;
      const operations = plan.operations.filter((operation): operation is ClipAlphaVectorOperation => operation.source === "vector" && Boolean(operation.fixedWindowV3));
      for (const [maskIndex, operation] of operations.entries()) {
        assertRenderActive();
        workDirectory ??= await createRenderWorkDirectory("editkin-filtergraph-");
        const directory = join(workDirectory, `${clipIndex}-${maskIndex}`); await mkdir(directory);
        for (let frame = 0; frame < operation.samples.length; frame += 1) {
          assertRenderActive();
          const png = fixedWindowMaskPngV3(operation, frame, project.width, project.height, maximum);
          await writeFile(join(directory, `frame-${String(frame).padStart(6, "0")}.png`), png, { flag: "wx", signal: renderLifetimeSignal() });
          assertRenderActive();
        }
        const planes = planesByClip.get(clip.id) ?? [];
        planes.push({ maskId: operation.maskId, pattern: join(directory, "frame-%06d.png"), frameCount: operation.samples.length });
        planesByClip.set(clip.id, planes);
      }
    }
    return { workDirectory, planesByClip };
  } catch (error) {
    if (workDirectory) await removeRenderWorkDirectory(workDirectory);
    throw error;
  }
}

/** Adds owned, clip-local PNG inputs at the exact compositor frame rate. */
export function appendFixedWindowMaskInputsV3(args: string[], planes: readonly FixedWindowMaskPlaneV3[] | undefined, firstIndex: number, rate: string): { nextIndex: number; inputIndexes?: ReadonlyMap<string, number> } {
  if (!planes?.length) return { nextIndex: firstIndex };
  const inputIndexes = new Map<string, number>(); let nextIndex = firstIndex;
  for (const plane of planes) {
    args.push("-framerate", rate, "-start_number", "0", "-i", plane.pattern);
    inputIndexes.set(plane.maskId, nextIndex++);
  }
  return { nextIndex, inputIndexes };
}
