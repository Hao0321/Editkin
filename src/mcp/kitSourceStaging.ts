// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Verified workspace snapshots for external media used by the unmodified Kit controller. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, realpathSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { readBoundedFile, readBoundedFileSync } from "./boundedFileRead";

type Source = { uri: string; original: string; sha256: string; bytes: number; mtimeMs: number; staged: string };
type Manifest = { schema: "editkin.kit-source-snapshot/v1"; project: string; sources: Source[] };
type Material = { clipId: string; sourcePath: string };
export type KitSourceProgress = { phase: "hashing" | "checking" | "copying" | "verifying" | "ready"; sourceIndex: number; sourceCount: number; bytesDone: number; bytesTotal: number };
export type KitSourceOptions = { signal?: AbortSignal; onProgress?: (progress: KitSourceProgress) => void };
const folder = ".editkin-kit-sources";
const shaPattern = /^[a-f0-9]{64}$/;
let pinnedProject = "";
let pinnedExternal = new Map<string, string>();

function within(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function uriPath(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
}

async function sha256File(path: string, options: KitSourceOptions = {}, tick?: (bytes: number) => void): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal: options.signal })) { digest.update(chunk); tick?.(chunk.length); }
  return digest.digest("hex");
}

async function copyWithProgress(source: string, destination: string, options: KitSourceOptions, tick: (bytes: number) => void): Promise<void> {
  await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    tick(chunk.length); callback(null, chunk);
  } }), createWriteStream(destination, { flags: "wx" }), { signal: options.signal });
}

function projectAssets(project: string, root: string): { assets: Array<{ id: string; uri: string }>; clips: Array<{ id: string; assetId: string }> } {
  const data = JSON.parse(readBoundedFileSync(project, root, 64 * 1024 * 1024).toString("utf8")) as any;
  if (!Array.isArray(data?.assets) || !Array.isArray(data?.tracks)) throw Error("Editkin project has no asset/track bindings");
  if (data.assets.some((value: any) => typeof value?.id !== "string" || !value.id || typeof value?.uri !== "string")
    || data.tracks.some((track: any) => !Array.isArray(track?.clips))) throw Error("Editkin project contains invalid source bindings");
  const assets = data.assets as Array<{ id: string; uri: string }>;
  if (new Set(assets.map(value => value.id)).size !== assets.length) throw Error("Editkin project contains duplicate asset IDs");
  const clips = data.tracks.flatMap((track: any) => track.clips) as Array<{ id: string; assetId: string }>;
  if (clips.some(value => typeof value?.id !== "string" || !value.id || typeof value?.assetId !== "string" || !value.assetId))
    throw Error("Editkin project contains invalid clip bindings");
  return { assets, clips };
}

export function pinKitProjectExternalSources(workspace: string, project: string): void {
  pinnedProject = "";
  pinnedExternal = new Map();
  if (!workspace && !project) return;
  // A synchronous read fixes the initial authorization before model calls.
  const root = realpathSync(workspace), file = realpathSync(project);
  if (!within(root, file) || !statSync(file).isFile()) throw Error("Kit project is outside the workspace");
  const { assets } = projectAssets(file, root);
  const sources = new Map<string, string>();
  for (const asset of assets) {
    if (asset.uri.length > 4096 || asset.uri.startsWith("creative://") || asset.uri.startsWith("editkin-composition://")) continue;
    let raw: string;
    try { raw = uriPath(asset.uri); } catch { continue; }
    if (!isAbsolute(raw) || within(resolve(workspace), resolve(raw))) continue;
    let canonical: string;
    try { canonical = realpathSync(raw); } catch { continue; }
    if (!within(root, canonical) && statSync(canonical).isFile()) sources.set(asset.uri, canonical);
  }
  pinnedProject = file;
  pinnedExternal = sources;
}

function readManifest(input: unknown, root: string, project: string): Manifest {
  const value = input as Manifest;
  if (value?.schema !== "editkin.kit-source-snapshot/v1" || value.project !== relative(root, project)
    || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 32) {
    throw Error("Kit source snapshot manifest is invalid");
  }
  for (const source of value.sources) {
    if (!source || typeof source.uri !== "string" || typeof source.original !== "string"
      || typeof source.staged !== "string" || !shaPattern.test(source.sha256)
      || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || !Number.isFinite(source.mtimeMs)
      || !isAbsolute(source.original) || !within(join(root, folder), resolve(root, source.staged))) {
      throw Error("Kit source snapshot entry is invalid");
    }
    try {
      if (realpathSync(uriPath(source.uri)) !== source.original) throw Error("Kit source snapshot origin changed");
    } catch { throw Error("Kit source snapshot origin is unavailable"); }
  }
  return value;
}

async function checkedSnapshot(manifestPath: string, root: string, project: string, expected: Source[], options: KitSourceOptions = {}, tick?: (index: number, bytes: number) => void): Promise<Manifest> {
  const manifest = readManifest(JSON.parse(await readFile(manifestPath, "utf8")), root, project);
  if (manifest.sources.length !== expected.length) throw Error("Kit source snapshot count changed");
  for (const [index, source] of manifest.sources.entries()) {
    const target = expected[index];
    if (source.uri !== target.uri || source.original !== target.original || source.sha256 !== target.sha256
      || source.staged !== target.staged || source.bytes !== target.bytes) throw Error("Kit source snapshot binding changed");
    const staged = realpathSync(resolve(root, source.staged));
    if (!within(join(root, folder), staged) || await sha256File(staged, options, bytes => tick?.(index, bytes)) !== source.sha256) throw Error("Kit source snapshot bytes changed");
  }
  return manifest;
}

function projectMaterialInputs(workspace: string, project: string, clipIds?: string[]) {
  const root = realpathSync(workspace), file = realpathSync(project);
  if (!within(root, file) || !statSync(file).isFile()) throw Error("Kit project is outside the workspace");
  const { assets, clips } = projectAssets(file, root);
  if (clipIds !== undefined && (!Array.isArray(clipIds) || clipIds.length < 1 || clipIds.length > 32
    || clipIds.some(id => typeof id !== "string" || !id || id.length > 1024)
    || new Set(clipIds).size !== clipIds.length)) throw Error("Kit clipIds must name 1–32 distinct project clips");
  const selected = clipIds === undefined ? undefined : new Set(clipIds);
  const byAsset = new Map(assets.map(asset => [asset.id, asset]));
  const materialInputs: Array<{ clipId: string; uri: string; original: string }> = [];
  const seen = new Set<string>();
  for (const clip of clips) {
    if (seen.has(clip.id)) throw Error("Editkin project has a duplicate clip ID");
    seen.add(clip.id);
    if (selected && !selected.has(clip.id)) continue;
    const asset = byAsset.get(clip.assetId);
    if (!asset) throw Error(`Kit material ${clip.id} has no source asset in the open project`);
    if (asset.id === "asset-demo") continue;
    if (asset.uri.startsWith("creative://") || asset.uri.startsWith("editkin-composition://") || asset.uri.startsWith("blob:"))
      throw Error(`Kit material ${clip.id} needs a real source file`);
    const raw = uriPath(asset.uri);
    const original = realpathSync(resolve(root, raw));
    if (!statSync(original).isFile()) throw Error(`Kit material ${clip.id} needs a real source file`);
    if (!within(root, original) && (file !== pinnedProject || pinnedExternal.get(asset.uri) !== original))
      throw Error(`Kit material ${clip.id} is not an original external import of this Agent session`);
    materialInputs.push({ clipId: clip.id, uri: asset.uri, original });
    if (materialInputs.length > 32) throw Error("Kit create supports at most 32 source clips");
  }
  if (selected && materialInputs.length !== selected.size) throw Error("Kit clipIds must name real, non-demo clips in the open project");
  if (!materialInputs.length) throw Error("請先加入自己的素材；示範片段不能建立完整自動剪輯流程");
  const external = [...new Map(materialInputs.filter(item => !within(root, item.original))
    .map(item => [item.original, item])).values()].sort((a, b) => a.original.localeCompare(b.original));
  return { root, file, materialInputs, external };
}

export function inspectKitProjectExternalSources(workspace: string, project: string, clipIds?: string[]): { count: number; bytes: number; sources: Array<{ path: string; bytes: number; mtimeMs: number }> } {
  const { external } = projectMaterialInputs(workspace, project, clipIds);
  const sources = external.map(item => { const facts = statSync(item.original); return { path: item.original, bytes: facts.size, mtimeMs: facts.mtimeMs }; });
  return { count: sources.length, bytes: sources.reduce((sum, item) => sum + item.bytes, 0), sources };
}

export async function stageKitProjectSources(workspace: string, project: string, options: KitSourceOptions = {}, clipIds?: string[]): Promise<{ materials: Material[]; stagedSources: Map<string, string>; snapshot?: string }> {
  const { root, file, materialInputs, external } = projectMaterialInputs(workspace, project, clipIds);
  if (!external.length) return { materials: materialInputs.map(item => ({ clipId: item.clipId, sourcePath: item.original })), stagedSources: new Map() };

  const sourceCount = external.length;
  const bytesTotal = external.reduce((sum, item) => sum + statSync(item.original).size, 0) * 3;
  let bytesDone = 0;
  const report = (phase: KitSourceProgress["phase"], sourceIndex: number) => options.onProgress?.({ phase, sourceIndex, sourceCount, bytesDone, bytesTotal });
  const tick = (phase: KitSourceProgress["phase"], sourceIndex: number) => (bytes: number) => { bytesDone += bytes; report(phase, sourceIndex); };
  const sourceFacts: Source[] = [];
  for (const [index, item] of external.entries()) {
    options.signal?.throwIfAborted();
    report("hashing", index + 1);
    const before = await stat(item.original);
    const sha256 = await sha256File(item.original, options, tick("hashing", index + 1));
    const after = await stat(item.original);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("原始素材在計算雜湊時發生變更；沒有建立 Kit 副本");
    sourceFacts.push({ uri: item.uri, original: item.original, sha256, bytes: after.size, mtimeMs: after.mtimeMs, staged: "" });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ project: relative(root, file),
    sources: sourceFacts.map(({ original, sha256 }) => ({ original, sha256 })) })).digest("hex");
  const packageRoot = join(root, folder), directory = join(packageRoot, fingerprint);
  await mkdir(directory, { recursive: true });
  if (!within(root, realpathSync(directory))) throw Error("Kit source snapshot directory leaves the project workspace");
  for (const [index, source] of sourceFacts.entries()) {
    const extension = extname(source.original).slice(0, 20).replace(/[^.a-zA-Z0-9]/g, "") || ".bin";
    source.staged = relative(root, join(directory, `source-${String(index + 1).padStart(2, "0")}${extension}`));
  }
  const manifestPath = join(directory, "manifest.json");
  options.signal?.throwIfAborted();
  try {
    report("checking", 1);
    const manifest = await checkedSnapshot(manifestPath, root, file, sourceFacts, options,
      (index, bytes) => tick("checking", index + 1)(bytes));
    report("ready", sourceCount);
    const map = new Map(manifest.sources.map(item => [item.original, resolve(root, item.staged)]));
    return { materials: materialInputs.map(item => ({ clipId: item.clipId, sourcePath: map.get(item.original) ?? item.original })), stagedSources: map, snapshot: manifestPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lockPath = join(directory, "stage.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A PID probe cannot prove the pathname still names the same lock. Never
    // replace another process's lock between the probe and exclusive open.
    throw Error("Kit 素材副本鎖已存在；請確認沒有進行中的工作，再清理殘留鎖並重試");
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    // A previous process's temporary files are left untouched here; this process
    // removes only its own copy in the corresponding finally block below.
    const missing: Source[] = [];
    for (const [index, source] of sourceFacts.entries()) {
      options.signal?.throwIfAborted();
      report("checking", index + 1);
      const destination = resolve(root, source.staged);
      try {
        if (await sha256File(destination, options, tick("checking", index + 1)) !== source.sha256) throw Error("既有 Kit 素材副本雜湊不符；未覆蓋或建立 workflow run");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.push(source);
      }
    }
    const disk = await statfs(directory);
    const needed = missing.reduce((sum, item) => sum + item.bytes, 0);
    if (disk.bavail * disk.bsize < needed + 256 * 1024 * 1024) throw Error("專案磁碟可用空間不足，無法建立 Kit 素材副本");
    for (const [index, source] of missing.entries()) {
      options.signal?.throwIfAborted();
      report("copying", index + 1);
      const destination = resolve(root, source.staged), temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await copyWithProgress(source.original, temporary, options, tick("copying", index + 1));
        report("verifying", index + 1);
        if (await sha256File(temporary, options, tick("verifying", index + 1)) !== source.sha256) throw Error("Kit 素材副本雜湊不符，未建立 workflow run");
        const originalNow = await stat(source.original);
        if (originalNow.size !== source.bytes || originalNow.mtimeMs !== source.mtimeMs) throw Error("原始素材在複製期間發生變更，未建立 workflow run");
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
    }
    options.signal?.throwIfAborted();
    const manifest: Manifest = { schema: "editkin.kit-source-snapshot/v1", project: relative(root, file), sources: sourceFacts };
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    try { await rename(temporary, manifestPath); } finally { await rm(temporary, { force: true }); }
    report("ready", sourceCount);
    const map = new Map(sourceFacts.map(item => [item.original, resolve(root, item.staged)]));
    return { materials: materialInputs.map(item => ({ clipId: item.clipId, sourcePath: map.get(item.original) ?? item.original })), stagedSources: map, snapshot: manifestPath };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export async function verifyKitRunExternalSources(workspace: string, project: string, runDirectory: string, full = false): Promise<void> {
  const root = realpathSync(workspace), file = realpathSync(project), run = realpathSync(runDirectory);
  if (!within(root, file) || !within(root, run)) throw Error("Kit run/source binding leaves the workspace");
  const statePath = join(run, "workflow-state.json");
  const state = JSON.parse((await readBoundedFile(statePath, root, 64 * 1024 * 1024)).toString("utf8")) as any;
  const materials = state?.binding?.materials;
  if (!Array.isArray(materials)) throw Error("Kit run has no source bindings");
  const staged = materials.filter((item: any) => {
    const path = item?.source_path;
    if (typeof path !== "string") return false;
    const portablePath = path.replaceAll("\\", "/");
    if (portablePath.split("/").includes(folder) && !portablePath.startsWith(`${folder}/`))
      throw Error("Kit staged source path is invalid");
    return portablePath.startsWith(`${folder}/`);
  });
  if (!staged.length) return;
  const { assets } = projectAssets(file, root);
  const currentUris = new Set(assets.map(item => item.uri));
  for (const material of staged) {
    const stagedPath = resolve(root, material.source_path.replaceAll("\\", "/"));
    const directory = resolve(stagedPath, "..");
    if (!shaPattern.test(relative(join(root, folder), directory)) || !within(join(root, folder), directory))
      throw Error("Kit staged source path is invalid");
    const manifest = readManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), root, file);
    const source = manifest.sources.find(item => resolve(root, item.staged) === stagedPath);
    if (!source || source.sha256 !== material.source_sha256 || !currentUris.has(source.uri)
      || realpathSync(source.original) !== source.original) throw Error("Kit source snapshot no longer matches the open project");
    const actual = await stat(source.original);
    if (actual.size !== source.bytes || full || actual.mtimeMs !== source.mtimeMs) {
      if (await sha256File(source.original) !== source.sha256) throw Error("原始素材在 Kit run 建立後變更；請停止套用並檢查素材");
    }
  }
}
