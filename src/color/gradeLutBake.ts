import type { ColorGradeV2 } from "../domain/visualTypes";
import { sampleCubeLut, serializeCube3d, type CubeLut } from "./cubeLut";
import { applyResolvedColorGradeV2, resolveColorGradeV2, type ColorLutResolver, type ResolvedColorGradeV2 } from "./gradeV2";
import type { GradeWorkingSpace, Vec3 } from "./gradeV2Color";

/**
 * One operation, three outputs: the non-spatial Color Grade v2 is baked once into a
 * 65³ table. FFmpeg export reads it through `lut3d` (tetrahedral), the browser/GPU
 * preview samples the identical Float32Array with the same tetrahedral rule, and
 * "export grade as .cube" writes the same values. Values are clamped to the 0–1
 * working surface and rounded to six decimals so the text file and the in-memory
 * table are bit-identical after float parsing.
 */
export const GRADE_LUT_SIZE = 65;
export const GRADE_LUT_SCHEMA = "editkin.color-grade-lut/v1" as const;

export interface BakedGradeLut extends CubeLut {
  schema: typeof GRADE_LUT_SCHEMA;
  space: GradeWorkingSpace;
  key: string;
}

const CACHE_LIMIT = 6;
const cache = new Map<string, BakedGradeLut>();

function round6(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6;
}

export function bakeResolvedGradeLut(resolved: ResolvedColorGradeV2, size = GRADE_LUT_SIZE): BakedGradeLut {
  if (!Number.isInteger(size) || size < 2 || size > 129) throw new Error("Grade LUT 尺寸必須介於 2–129");
  const cacheKey = `${size}:${resolved.key}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey); cache.set(cacheKey, cached);
    return cached;
  }
  const values = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  const rgb: Vec3 = [0, 0, 0];
  let offset = 0;
  for (let blue = 0; blue < size; blue += 1) {
    rgb[2] = blue * step;
    for (let green = 0; green < size; green += 1) {
      rgb[1] = green * step;
      for (let red = 0; red < size; red += 1) {
        rgb[0] = red * step;
        const graded = resolved.identity ? rgb : applyResolvedColorGradeV2(resolved, rgb);
        values[offset] = round6(graded[0]);
        values[offset + 1] = round6(graded[1]);
        values[offset + 2] = round6(graded[2]);
        offset += 3;
      }
    }
  }
  const baked: BakedGradeLut = { schema: GRADE_LUT_SCHEMA, space: resolved.space, key: resolved.key, size,
    domainMin: [0, 0, 0], domainMax: [1, 1, 1], values };
  cache.set(cacheKey, baked);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return baked;
}

export function bakeColorGradeLut(grade: ColorGradeV2, space: GradeWorkingSpace, resolveLut?: ColorLutResolver, size = GRADE_LUT_SIZE): BakedGradeLut {
  return bakeResolvedGradeLut(resolveColorGradeV2(grade, space, resolveLut), size);
}

/** Tetrahedral sample of a baked table (the same rule as FFmpeg lut3d and the preview shader). */
export function sampleBakedGradeLut(baked: BakedGradeLut, rgb: Vec3): Vec3 {
  return sampleCubeLut(baked, rgb);
}

export function bakedGradeLutCubeText(baked: BakedGradeLut, title: string): string {
  return serializeCube3d(baked.values, baked.size, title);
}

/**
 * The copy FFmpeg reads during export. vf_lut3d writes integer outputs by truncation
 * (`(int)(v·max)`), so the 8-bit render copy carries a constant +0.5-code offset: its
 * truncated result equals round(table·255), i.e. exactly what the preview sampler shows.
 * Tetrahedral weights sum to one, so the offset is exact at every interpolated point.
 * 16-bit surfaces keep the plain table (the truncation bias is 0.5/65535).
 */
export function ffmpegRenderCubeText(baked: BakedGradeLut, title: string, highBitDepth: boolean): string {
  if (highBitDepth) return bakedGradeLutCubeText(baked, title);
  const bias = 0.5 / 255;
  const biased = new Float32Array(baked.values.length);
  for (let index = 0; index < biased.length; index += 1) biased[index] = Math.round((baked.values[index] + bias) * 1e6) / 1e6;
  return serializeCube3d(biased, baked.size, `${title} (8-bit truncation-compensated render copy)`);
}

/**
 * "Export the whole grade as .cube": the non-spatial grade for the given working space.
 * Spatial finishing (grain, halation, bloom, vignette) cannot live in a LUT and is
 * reported back so callers can tell the user what the file omits.
 */
export function exportColorGradeV2Cube(grade: ColorGradeV2, space: GradeWorkingSpace, title: string, resolveLut?: ColorLutResolver, size = GRADE_LUT_SIZE): {
  text: string; size: number; space: GradeWorkingSpace; omittedSpatial: string[];
} {
  const resolved = resolveColorGradeV2(grade, space, resolveLut);
  const baked = bakeResolvedGradeLut(resolved, size);
  const omittedSpatial = Object.keys(resolved.finishing ?? {});
  const header = `Editkin Color Grade v2 (${space === "acescct" ? "ACEScct in/out" : "Rec.709 display in/out"})`;
  return { text: bakedGradeLutCubeText(baked, `${title} · ${header}`), size, space, omittedSpatial };
}

export function clearGradeLutCache(): void {
  cache.clear();
}
