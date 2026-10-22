import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { parseCubeFile } from "../color/cubeLut";
import { exportClipGradeCube, importColorLut, listColorLuts, resolveColorLut } from "./creativeLibrary";

let root = "";
let library = "";
const CUBE_3D = (() => {
  const rows: string[] = [];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${r * 0.9 + 0.05} ${g} ${b * 0.8}`);
  return `TITLE "Owner warm"\nLUT_3D_SIZE 2\n${rows.join("\n")}\n`;
})();
const RIGHTS = { license: "CC0-1.0", provenance: "Hao 自製 2026-10", rightsBasis: "owner-authored", inputSpace: "rec709_display" as const };

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-lut-library-")); library = join(root, "library"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function cubeFile(name: string, text: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, text, "utf8");
  return path;
}

function gradedProject(lut?: { id: string; sha256: string }): EditProject {
  const project = createEmptyProject("LUT export", { width: 360, height: 640, fps: 30 });
  project.assets.push({ id: "a", name: "a", uri: "a.mp4", kind: "video", duration: 4, width: 360, height: 640 });
  project.tracks[0].clips.push({ id: "c", trackId: "video-main", assetId: "a", timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    gradeV2: { schema: "editkin.color-grade/v2", nodes: lut ? [{ id: "lut", lut: { ...lut, strength: 0.7 } }] : [], look: { id: "hfl2_vlog_soft_film" } } });
  return project;
}

describe("Color LUT library", () => {
  it("imports a validated .cube content-addressed with licence, provenance and rights basis", async () => {
    const entry = await importColorLut(library, { sourcePath: await cubeFile("warm.cube", CUBE_3D), name: "Owner warm", ...RIGHTS });
    expect(entry).toMatchObject({ kind: "3d", size: 2, name: "Owner warm", license: "CC0-1.0", provenance: "Hao 自製 2026-10", rightsBasis: "owner-authored", title: "Owner warm" });
    expect(entry.id).toBe(`lut:${entry.sha256.slice(0, 16)}`);
    expect(await readFile(join(library, entry.path), "utf8")).toBe(CUBE_3D);
    expect(await listColorLuts(library)).toEqual([entry]);
    expect(await importColorLut(library, { sourcePath: await cubeFile("again.cube", CUBE_3D), name: "Other name", ...RIGHTS })).toEqual(entry);
    await expect(importColorLut(library, { sourcePath: await cubeFile("conflict.cube", CUBE_3D), name: "x", ...RIGHTS, license: "Proprietary" })).rejects.toThrow(/不同授權/);
    const oneD = await importColorLut(library, { sourcePath: await cubeFile("curve.cube", "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n"), name: "Curve", ...RIGHTS });
    expect(oneD.kind).toBe("1d");
    expect((await listColorLuts(library)).map(item => item.id)).toEqual([entry.id, oneD.id]);
  });

  it("refuses anonymous, malformed or non-.cube imports", async () => {
    const path = await cubeFile("warm.cube", CUBE_3D);
    await expect(importColorLut(library, { sourcePath: path, name: "x", ...RIGHTS, license: " " })).rejects.toThrow(/license/);
    await expect(importColorLut(library, { sourcePath: path, name: "x", ...RIGHTS, rightsBasis: "" })).rejects.toThrow(/rightsBasis/);
    await expect(importColorLut(library, { sourcePath: await cubeFile("bad.cube", "LUT_3D_SIZE 2\n0 0 0\n"), name: "x", ...RIGHTS })).rejects.toThrow(/不完整/);
    await expect(importColorLut(library, { sourcePath: await cubeFile("bad.txt", CUBE_3D), name: "x", ...RIGHTS })).rejects.toThrow(/\.cube/);
    expect(await listColorLuts(library)).toEqual([]);
  });

  it("resolves by id only when manifest, bytes and full SHA-256 agree", async () => {
    const entry = await importColorLut(library, { sourcePath: await cubeFile("warm.cube", CUBE_3D), name: "Owner warm", ...RIGHTS });
    const resolved = await resolveColorLut(library, entry.id, entry.sha256);
    expect(resolved.cube.kind).toBe("3d");
    await expect(resolveColorLut(library, entry.id, "f".repeat(64))).rejects.toThrow(/SHA-256/);
    await writeFile(join(library, entry.path), CUBE_3D.replace("0.05", "0.06"));
    await expect(resolveColorLut(library, entry.id)).rejects.toThrow(/完整性/);
  });

  it("exports the whole clip grade (LUT node strength + film look) as a 65³ .cube without overwriting", async () => {
    const entry = await importColorLut(library, { sourcePath: await cubeFile("warm.cube", CUBE_3D), name: "Owner warm", ...RIGHTS });
    const output = join(root, "exports", "clip.cube");
    const exported = await exportClipGradeCube(gradedProject(entry), "c", output, library);
    expect(exported).toMatchObject({ size: 65, space: "rec709_display" });
    expect(exported.omittedSpatial.sort()).toEqual(["grain", "halation"]);
    const parsed = parseCubeFile(await readFile(output, "utf8"));
    expect(parsed.kind).toBe("3d"); expect(parsed.size).toBe(65);
    await expect(exportClipGradeCube(gradedProject(entry), "c", output, library)).rejects.toThrow();
    const aces = gradedProject(entry);
    aces.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    await expect(exportClipGradeCube(aces, "c", join(root, "exports", "aces.cube"), library)).rejects.toThrow(/工作空間/);
    await expect(exportClipGradeCube(gradedProject(), "missing", join(root, "x.cube"), library)).rejects.toThrow(/沒有 Color Grade v2/);
  });
});
