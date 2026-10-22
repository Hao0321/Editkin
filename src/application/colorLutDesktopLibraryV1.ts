import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CUBE_MAX_SOURCE_BYTES, parseCubeFile } from "../color/cubeLut";
import { COLOR_LUT_DESKTOP_MANIFEST_BYTES_V1, colorLutDesktopEntryV1Schema, colorLutDesktopRequestV1Schema, type ColorLutDesktopEntryV1 } from "../domain/colorLutDesktopContractV1";
import { readBoundedFile } from "../shared/boundedFile";
import { importColorLut } from "./creativeLibrary";
import { acquireProjectLock } from "./projectFiles";
const MANIFEST = "editkin-color-luts.json";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Host selects the root. Payloads can only choose a registered LUT ID or an explicitly picked source. */
async function plainLocalPath(path: string, missing = false): Promise<string> {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error("LUT 素材庫路徑或檔案不合法。");
  const target = resolve(path);
  for (let current = target; ; current = dirname(current)) {
    try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error("LUT 素材庫不可經過連結路徑。"); }
    catch (e) { if (!missing || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (dirname(current) === current) break;
  }
  return target;
}
async function manifest(root: string): Promise<ColorLutDesktopEntryV1[]> {
  const path = await plainLocalPath(join(root, MANIFEST), true);
  let bytes: Buffer;
  try { bytes = await readBoundedFile(path, COLOR_LUT_DESKTOP_MANIFEST_BYTES_V1, { messages: { tooLarge: "LUT 素材庫 metadata 超過 8 MiB 上限。" } }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value.schema !== "editkin.color-lut-library/v1" || !Array.isArray(value.luts) || Object.keys(value).some(k => !["schema", "luts"].includes(k))) throw new Error("LUT 素材庫 metadata 不合法。");
  const entries: ColorLutDesktopEntryV1[] = value.luts.map((e: unknown) => colorLutDesktopEntryV1Schema.parse(e));
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error("LUT 素材庫有重複身分。");
  return entries;
}
async function verifiedBytes(root: string, entry: ColorLutDesktopEntryV1) {
  const absolutePath = await plainLocalPath(join(root, entry.path));
  const bytes = await readBoundedFile(absolutePath, CUBE_MAX_SOURCE_BYTES, { messages: { tooLarge: "LUT 內容超過 64 MiB 上限。" } });
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error("LUT 內容或色彩空間與調色引用不符。");
  const cube = parseCubeFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (cube.kind !== entry.kind || cube.size !== entry.size) throw new Error("LUT 內容或色彩空間與調色引用不符。");
  return { absolutePath, bytes };
}
/** New desktop boundary over the existing content-addressed library; no project/renderer edits. */
export async function desktopColorLutLibraryV1(configuredRoot: string | undefined, payload: unknown) {
  const request = colorLutDesktopRequestV1Schema.parse(payload);
  if (!configuredRoot) throw new Error("LUT 素材庫未設定。");
  const root = await plainLocalPath(configuredRoot, true);
  if (request.operation === "list") {
    const entries = await manifest(root), page = entries.slice(request.offset, request.offset + request.limit);
    return { entries: page, total: entries.length, ...(request.offset + page.length < entries.length ? { nextOffset: request.offset + page.length } : {}) };
  }
  if (request.operation === "resolve") {
    const entry = (await manifest(root)).find(e => e.id === request.id);
    if (!entry || entry.sha256 !== request.sha256 || entry.inputSpace !== request.inputSpace) throw new Error("LUT 內容或色彩空間與調色引用不符。");
    const { absolutePath } = await verifiedBytes(root, entry);
    // Metadata/path only: full64MiB cubes must not be stuffed into the resident32MiB JSON response.
    return { entry, absolutePath };
  }
  if (!/\.cube$/i.test(request.sourcePath)) throw new Error("LUT 匯入只接受 .cube 檔。");
  const source = await plainLocalPath(request.sourcePath), bytes = await readBoundedFile(source, CUBE_MAX_SOURCE_BYTES, { messages: { tooLarge: "LUT 內容超過 64 MiB 上限。" } });
  const parsed = parseCubeFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const sha256 = hash(bytes);
  await mkdir(root, { recursive: true }); await plainLocalPath(root);
  const release = await acquireProjectLock(join(root, MANIFEST));
  let staging: string | undefined;
  try {
    const entries = await manifest(root), existing = entries.find(e => e.sha256 === sha256);
    if (existing) await verifiedBytes(root, existing);
    if (!existing) {
      const candidate = { id: `lut:${sha256.slice(0, 16)}`, sha256, name: request.name, license: request.license, provenance: request.provenance, rightsBasis: request.rightsBasis, inputSpace: request.inputSpace,
        kind: parsed.kind, size: parsed.size, bytes: bytes.length, path: `luts/${sha256}.cube`, ...(parsed.title ? { title: parsed.title } : {}), importedAt: new Date().toISOString() };
      if (Buffer.byteLength(JSON.stringify({ schema: "editkin.color-lut-library/v1", luts: [...entries, candidate] }, null, 2)) + 1 > COLOR_LUT_DESKTOP_MANIFEST_BYTES_V1) throw new Error("LUT 素材庫 metadata 超過 8 MiB 上限。");
    }
    const target = join(root, "luts", `${sha256}.cube`);
    await plainLocalPath(target, true);
    // Refuse a corrupt orphan before the legacy importer can index that existing path.
    try { const stored = await readBoundedFile(target, CUBE_MAX_SOURCE_BYTES); if (hash(stored) !== sha256) throw new Error("LUT 內容或色彩空間與調色引用不符。"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const stagingPath = join(root, `.desktop-import-${randomUUID()}.cube`), handle = await open(stagingPath, "wx");
    staging = stagingPath;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    const entry = await importColorLut(root, { ...request, sourcePath: staging });
    colorLutDesktopEntryV1Schema.parse(entry); await verifiedBytes(root, entry);
    return { entry, nodeReference: { id: entry.id, sha256: entry.sha256, strength: 1 } };
  } finally { try { if (staging) await rm(staging); } finally { await release(); } }
}
