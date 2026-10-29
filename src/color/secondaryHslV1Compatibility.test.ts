import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyResolvedColorGradeV2, resolveColorGradeV2 } from "./gradeV2";
import { bakeResolvedGradeLut, ffmpegRenderCubeText } from "./gradeLutBake";
import type { ColorGradeV2 } from "../domain/visualTypes";
import type { GradeWorkingSpace, Vec3 } from "./gradeV2Color";

interface GoldenCase { grade: ColorGradeV2; space: GradeWorkingSpace; identity: boolean; keySha256: string; pixels: Vec3[]; lutSize: number; lutFloat32Sha256: string }
const fixture = JSON.parse(readFileSync(new URL("./secondaryHslV1Compatibility.fixture.json", import.meta.url), "utf8")) as {
  sourceBaseline: number; filmLooks: number; pixels: Vec3[]; cases: GoldenCase[];
  fullCube: { grade: ColorGradeV2; space: GradeWorkingSpace; size: number; float32Sha256: string; render8BitSha256: string; render16BitSha256: string };
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
describe("original source1745 grades remain byte exact without the new selector", () => {
  it.each(fixture.cases.map((entry, index) => ({ ...entry, index })))("preserves original case $index in $space", entry => {
    const resolved = resolveColorGradeV2(entry.grade, entry.space);
    expect(resolved.identity).toBe(entry.identity);
    expect(hash(resolved.key)).toBe(entry.keySha256);
    expect(fixture.pixels.map(rgb => applyResolvedColorGradeV2(resolved, rgb))).toEqual(entry.pixels);
    const cube = bakeResolvedGradeLut(resolved, entry.lutSize);
    expect(hash(new Uint8Array(cube.values.buffer, cube.values.byteOffset, cube.values.byteLength))).toBe(entry.lutFloat32Sha256);
  });
  it("preserves the original complete65³ Float32 table and both FFmpeg delivery texts", () => {
    expect(fixture.sourceBaseline).toBe(1745);
    expect(fixture.filmLooks).toBe(14);
    const entry = fixture.fullCube, cube = bakeResolvedGradeLut(resolveColorGradeV2(entry.grade, entry.space), entry.size);
    expect(hash(new Uint8Array(cube.values.buffer))).toBe(entry.float32Sha256);
    expect(hash(ffmpegRenderCubeText(cube, "Legacy secondary HSL control", false))).toBe(entry.render8BitSha256);
    expect(hash(ffmpegRenderCubeText(cube, "Legacy secondary HSL control", true))).toBe(entry.render16BitSha256);
  });
});
