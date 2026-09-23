import { readFile, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { bundledFontMetricDigest } from "../typography/fontEmMetrics";

/** Private/legacy roots remain explicit legacy mode; malformed v2 never falls back. */
export async function resolveAssFontRoot(fontRoot?: string, project?: EditProject): Promise<{ fontRoot?: string; bundledFaces: boolean }> {
  if (!fontRoot) return { bundledFaces: false };
  if (!isAbsolute(fontRoot)) throw new Error("Font root must be absolute");
  const root = resolve(fontRoot);
  let raw: string;
  try { raw = await readFile(join(root, "editkin-open-fonts.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fontRoot: root, bundledFaces: false }; throw error; }
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion === 1) return { fontRoot: root, bundledFaces: false };
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.fonts) || !manifest.fonts.length) throw new Error("Invalid font manifest schema");
  const faces = new Map<string, { bytes: number; sha256: string }>();
  const families = new Set<string>();
  for (const entry of manifest.fonts) {
    if (!entry || typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id) || typeof entry.family !== "string" || families.has(entry.family) || !Array.isArray(entry.faces) || !entry.faces.length) throw new Error("Invalid font family manifest");
    families.add(entry.family);
    const weights = new Set<number>();
    for (const face of entry.faces) {
      if (!face || !Number.isFinite(face.weight) || face.weight < 100 || face.weight > 900 || weights.has(face.weight)
        || face.file !== `render/EditkinFace-${entry.id}-${face.weight}.ttf` || faces.has(face.file)
        || face.family !== `EditkinFace ${entry.id} ${face.weight}` || !Number.isSafeInteger(face.bytes) || face.bytes <= 0
        || typeof face.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(face.sha256)) throw new Error("Invalid physical font face manifest");
      weights.add(face.weight); faces.set(face.file, face);
    }
  }
  const physicalRoot = join(root, "render");
  for (const graphic of project?.motionGraphics ?? []) {
    if (graphic.schema !== "hao.motion-composition/v2") continue;
    const family = graphic.fontFamily ?? "Noto Sans TC", weight = graphic.fontWeight ?? 700;
    const file = resolveBundledFontFace(family, weight)?.fontFile;
    if (!file || faces.get(file)?.sha256 !== bundledFontMetricDigest(family, weight)) throw new Error("v2 physical font does not match its measured em metrics");
  }
  if ((await lstat(physicalRoot)).isSymbolicLink() || await realpath(physicalRoot) !== join(await realpath(root), "render")) throw new Error("Physical font directory escapes root");
  const requested = project ? [
    [project.captionStyle.fontFamily, project.captionStyle.bold ? 800 : 400],
    [project.captionStyle.translationFontFamily, project.captionStyle.translationBold ? 800 : 400],
    ...project.motionGraphics.map(g => [g.fontFamily ?? "Noto Sans TC", g.fontWeight ?? 700]),
  ] as [string, number][] : [];
  for (const file of new Set(requested.map(([family, weight]) => resolveBundledFontFace(family, weight)?.fontFile).filter((file): file is string => Boolean(file)))) {
    const face = faces.get(file);
    if (!face) throw new Error(`Required physical font missing: ${file}`);
    const path = join(root, file), before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== join(await realpath(root), file) || before.size !== face.bytes) throw new Error(`Invalid physical font file: ${file}`);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    const after = await lstat(path);
    if (digest !== face.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`Physical font integrity mismatch: ${file}`);
  }
  return { fontRoot: physicalRoot, bundledFaces: true };
}
