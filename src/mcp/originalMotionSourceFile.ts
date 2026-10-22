import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { readBundledFontFace } from "../render/bundledFontSource";
import { prepareGlyphRun, PREPARED_GLYPH_PARSER_VERSION, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { originalMotionSourceAuthoringSchema, originalMotionSourceRightsSchema, prepareOriginalMotionSourceEvidence,
  type OriginalMotionAuthoringSource } from "../application/originalMotionSourceEvidence";

export const ORIGINAL_MOTION_AUTHORING_MAX_BYTES = 256 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
export const originalMotionAuthoringFileSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-authoring/v1"), usage: z.enum(["standalone", "authored_overlay"]),
  audio: z.enum(["silent", "preserve_source_audio"]), fps: z.number().finite().min(1).max(240),
  authoring: originalMotionSourceAuthoringSchema, rights: originalMotionSourceRightsSchema,
  fontBindings: z.array(z.strictObject({ graphicId: id, faceId: z.string().min(1).max(100), fontSha256: sha,
    manifestSha256: sha, parserVersion: z.literal(PREPARED_GLYPH_PARSER_VERSION) })).max(32),
}).superRefine((payload, context) => {
  if ((payload.usage === "standalone" ? "standalone_showcase" : "authored_overlay") !== payload.authoring.intent
    || payload.audio !== (payload.usage === "standalone" ? "silent" : "preserve_source_audio")) {
    context.addIssue({ code: "custom", message: "Original source usage/intent/audio must match its actual surface" });
  }
  const textIds = payload.authoring.elements.filter(element => element.kind === "text").map(element => element.id);
  if (new Set(payload.fontBindings.map(binding => binding.graphicId)).size !== payload.fontBindings.length
    || payload.fontBindings.length !== textIds.length || payload.fontBindings.some(binding => !textIds.includes(binding.graphicId))) {
    context.addIssue({ code: "custom", message: "Original source font bindings must cover each text graphic exactly once" });
  }
});
export type OriginalMotionAuthoringFile = z.infer<typeof originalMotionAuthoringFileSchema>;
/** Canonical v4 file admission has a stricter authoring prerequisite than the
 * general scene compiler. Keep static-camera component scenes available while
 * refusing a file that the canonical controller cannot subsequently admit.
 * Never infer or append a focus event from a saved/compiled scene. */
export function assertCanonicalOriginalSourceAuthoring(payload: OriginalMotionAuthoringFile): void {
  if (!payload.authoring.semanticCues.some(cue => cue.focus !== undefined)) {
    throw new Error("ORIGINAL_SOURCE_FOCUS_REQUIRED: 自動剪輯原稿至少需要一個明示鏡頭焦點（semanticCues[].focus）。請在原始創作時設定；不能向已保存場景補事件冒充同一版本。");
  }
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stableIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && (a.mode & 0o170000n) === (b.mode & 0o170000n) && a.size === b.size;
const sameMetadata = (a: BigIntStats, b: BigIntStats) => stableIdentity(a, b) && a.mode === b.mode && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
// Directory content metadata changes when unrelated files are created. Bind
// the directory object and namespace, rather than its mutable entry list.
const sameDirectoryIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && (a.mode & 0o170000n) === (b.mode & 0o170000n) && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
async function directoryIdentity(path: string): Promise<{ path: string; stat: BigIntStats }> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error("Original source ancestors must be fixed regular directories");
  return { path, stat };
}
async function directoryChain(root: string, sourceDirectory: string) {
  const anchor = parse(root).root, chain = [await directoryIdentity(anchor)];
  let current = anchor;
  for (const component of relative(anchor, sourceDirectory).split(sep).filter(Boolean)) {
    current = join(current, component); chain.push(await directoryIdentity(current));
  }
  return chain;
}

/** Only canonical UTF-8 JSON (plus one optional LF) in the dedicated owned directory.
 * A duplicate key, BOM, pretty-print alias, path link or non-file fails closed. */
export async function readOriginalMotionAuthoringSource(sourcePath: string, workspace: string): Promise<{
  source: OriginalMotionAuthoringSource; payload: OriginalMotionAuthoringFile;
}> {
  if (typeof sourcePath !== "string" || !/^\.editkin\/original-sources\/[a-z0-9][a-z0-9._-]{0,79}\.json$/i.test(sourcePath)) {
    throw new Error("Original source path must be .editkin/original-sources/<safe-id>.json");
  }
  if (!isAbsolute(workspace)) throw new Error("Original source workspace must be absolute");
  const root = resolve(workspace), directory = join(root, ".editkin", "original-sources"), path = resolve(root, sourcePath);
  const directories = await directoryChain(root, directory), before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await realpath(path), path)) throw new Error("Original source must be an unaliased regular file");
  if (before.size <= 0n || before.size > BigInt(ORIGINAL_MOTION_AUTHORING_MAX_BYTES)) throw new Error("Original source exceeds its bounded file size");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    // Same-path and same-handle snapshots retain full timestamps; cross-API
    // identity compares stable dev/inode/type/size without assuming precision.
    if (!opened.isFile() || opened.nlink !== 1n || !stableIdentity(before, opened)) throw new Error("Original source changed before bounded read");
    bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Original source changed during bounded read"); offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, offset), after = await handle.stat({ bigint: true });
    const atPath = await lstat(path, { bigint: true });
    if (extra.bytesRead !== 0 || !sameMetadata(opened, after) || !sameMetadata(before, atPath)
      || !atPath.isFile() || atPath.isSymbolicLink() || !stableIdentity(after, atPath) || !samePath(await realpath(path), path)) throw new Error("Original source changed during bounded read");
    for (const ancestor of directories) {
      const current = await directoryIdentity(ancestor.path);
      if (!sameDirectoryIdentity(ancestor.stat, current.stat)) throw new Error("Original source ancestor changed during bounded read");
    }
  } finally { await handle.close(); }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const json = text.endsWith("\n") ? text.slice(0, -1) : text;
  const payload = originalMotionAuthoringFileSchema.parse(JSON.parse(json));
  const canonical = canonicalJson(payload);
  if (json !== canonical) throw new Error("Original source must be normalized canonical JSON; duplicate keys/format aliases are rejected");
  assertCanonicalOriginalSourceAuthoring(payload);
  return { source: { sourcePath, sourceSha256: digest(bytes), sourcePayloadSha256: digest(canonical), bytes: bytes.length }, payload };
}

export type OriginalMotionTextProvider = ((faceId: string, text: string) => Promise<PreparedGlyphRun>) & { dispose(): void };
/** Two retained selected faces at most (32MiB); reads/preparation are sequential
 * in the scene compiler. A new uncached read plus the factory-owned byte copy
 * can temporarily add 32MiB. Parsed font and bounded outline memory is separate.
 * dispose drops the owned cache and blocks late preparation after release. */
export function originalMotionTextProvider(fontRoot: string): OriginalMotionTextProvider {
  const cache = new Map<string, Uint8Array>(); let disposed = false;
  const provider: OriginalMotionTextProvider = Object.assign(async (faceId: string, text: string) => {
    if (disposed) throw new Error("Original Motion text provider was disposed");
    bundledFontFaceSpec(faceId);
    let bytes = cache.get(faceId);
    if (!bytes) {
      bytes = await readBundledFontFace(fontRoot, faceId);
      if (disposed) throw new Error("Original Motion text provider was disposed during read");
      if (cache.size < 2) cache.set(faceId, bytes);
    }
    const run = await prepareGlyphRun(faceId, text, bytes);
    if (disposed) throw new Error("Original Motion text provider was disposed during preparation");
    return run;
  }, { dispose() { disposed = true; cache.clear(); } });
  return provider;
}

export async function prepareOriginalMotionSourceFile(project: EditProject, sourcePath: string, commandIndexOffset: number,
  options: { workspace: string; fontRoot: string }) {
  const loaded = await readOriginalMotionAuthoringSource(sourcePath, options.workspace);
  if (loaded.payload.fps !== project.fps) throw new Error("Original source file fps differs from the current project");
  const provider = originalMotionTextProvider(options.fontRoot);
  try {
    const prepared = await prepareOriginalMotionSourceEvidence(project, loaded.payload.authoring, loaded.payload.rights, commandIndexOffset,
      { prepareText: provider, authoringSource: loaded.source });
    const actual = prepared.preparation.graphicBindings.flatMap(binding => binding.physicalFont ? [{ graphicId: binding.graphicId,
      faceId: binding.physicalFont.faceId, fontSha256: binding.physicalFont.fontSha256,
      manifestSha256: binding.physicalFont.manifestSha256, parserVersion: binding.physicalFont.parserVersion }] : []);
    const byId = (left: { graphicId: string }, right: { graphicId: string }) => left.graphicId.localeCompare(right.graphicId, "en");
    if (canonicalJson([...actual].sort(byId)) !== canonicalJson([...loaded.payload.fontBindings].sort(byId))) throw new Error("Original source file font provenance differs from actual physical preparation");
    const after = await readOriginalMotionAuthoringSource(sourcePath, options.workspace);
    if (canonicalJson(after.source) !== canonicalJson(loaded.source) || canonicalJson(after.payload) !== canonicalJson(loaded.payload)) throw new Error("Original source changed during actual scene preparation");
    if (digest(canonicalJson(project)) !== prepared.evidence.project.sha256) throw new Error("Original Motion project changed after its source preparation");
    return { source: loaded.source, prepared };
  } finally { provider.dispose(); }
}
