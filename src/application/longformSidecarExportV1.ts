import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decodeProjectBytes, PROJECT_MAX_BYTES } from "./projectCodec";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { readBoundedFile } from "../shared/boundedFile";
import { CAPTION_DELIVERY_LIMITS, type CaptionDeliveryMode } from "../domain/captionDelivery";
import { LONGFORM_SIDECAR_LIMITS_V1, prepareLongformSidecarBundleV1 } from "../domain/longformSidecarBundleV1";

export interface LongformSidecarPrepareRequestV1 {
  projectPath: string; expectedProjectRevision: number; chapterMarkerIds: readonly string[]; captionMode: CaptionDeliveryMode;
}
export interface LongformSidecarExportRequestV1 extends LongformSidecarPrepareRequestV1 {
  expectedProjectSha256: string; expectedProjectFileSha256: string; expectedBundleSha256: string; outputDirectory: string;
}
export interface LongformSidecarRuntimeV1 { workspaceRoot: string; }
export type LongformSidecarPhaseV1 = "before_directory" | "directory_created" | "captions_written" | "chapters_written";
export interface LongformSidecarExportOptionsV1 { signal?: AbortSignal; onPhase?: (phase: LongformSidecarPhaseV1) => Promise<void>; }
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const equalPath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameDirectory = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
function confined(root: string, input: string) {
  if (typeof input !== "string" || !input.trim() || input.length > 1024 || /[\u0000-\u001f\u007f]/u.test(input)) throw Error("SIDECAR_PATH");
  const target = resolve(root, input), relation = relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw Error("SIDECAR_WORKSPACE_BOUNDARY");
  // Refuse Windows alternate data streams rather than treating them as ordinary paths.
  if (relation.split(sep).some(component => component.includes(":"))) throw Error("SIDECAR_PATH_STREAM");
  return target;
}
async function directoryPins(root: string, parent: string) {
  const relation = relative(root, parent);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw Error("SIDECAR_WORKSPACE_BOUNDARY");
  const paths = [root];
  for (const component of relation.split(sep).filter(Boolean)) paths.push(join(paths.at(-1)!, component));
  const pins: Array<{ path: string; stat: Stats }> = [];
  for (const path of paths) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(await realpath(path), path)) throw Error("SIDECAR_DIRECTORY_REPARSE_OR_ALIAS");
    pins.push({ path, stat });
  }
  return pins;
}
async function verifyDirectories(pins: Awaited<ReturnType<typeof directoryPins>>) {
  for (const pin of pins) {
    const current = await lstat(pin.path);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectory(pin.stat, current)
      || !equalPath(await realpath(pin.path), pin.path)) throw Error("SIDECAR_DIRECTORY_CHANGED");
  }
}
async function prepared(runtime: LongformSidecarRuntimeV1, request: LongformSidecarPrepareRequestV1) {
  if (!Number.isSafeInteger(request.expectedProjectRevision) || request.expectedProjectRevision < 0) throw Error("SIDECAR_PROJECT_REVISION");
  const root = resolve(runtime.workspaceRoot), projectPath = confined(root, request.projectPath);
  if (!/\.(?:editkin|haoedit)\.json$/i.test(projectPath)) throw Error("SIDECAR_PROJECT_EXTENSION");
  const pins = await directoryPins(root, dirname(projectPath));
  const bytes = await readBoundedFile(projectPath, PROJECT_MAX_BYTES), project = decodeProjectBytes(bytes);
  await verifyDirectories(pins);
  if (project.revision !== request.expectedProjectRevision) throw Error("SIDECAR_STALE_PROJECT_REVISION");
  const content = prepareLongformSidecarBundleV1(project, request.chapterMarkerIds, request.captionMode);
  const binding = { projectId: project.id, projectRevision: project.revision, projectSha256: sha256Canonical(project), projectFileSha256: sha(bytes) };
  const files = content.files.map(file => ({ ...file, contentSha256: sha(file.text) }));
  const metadata = { binding, schema: content.schema, policy: content.policy, captionMode: content.captionMode,
    cueCount: content.cueCount, captionWarnings: content.captionWarnings, timelineDurationSeconds: content.timelineDurationSeconds,
    chapters: content.chapters, files: files.map(({ name, utf8Bytes, contentSha256 }) => ({ name, utf8Bytes, contentSha256 })),
    projectModified: content.projectModified, boundary: content.boundary };
  return { root, projectPath, pins, files, binding, metadata, bundleSha256: sha256Canonical(metadata) };
}
export async function prepareLongformSidecarExportV1(runtime: LongformSidecarRuntimeV1, request: LongformSidecarPrepareRequestV1) {
  const current = await prepared(runtime, request);
  return { status: "PREPARED" as const, ...current.metadata, bundleSha256: current.bundleSha256,
    files: current.files.map(file => {
      let end = Math.min(file.text.length, 4096);
      if (end < file.text.length && /[\ud800-\udbff]/u.test(file.text[end - 1])) end--;
      const preview = file.text.slice(0, end);
      return { name: file.name, utf8Bytes: file.utf8Bytes, contentSha256: file.contentSha256, preview, previewTruncated: end < file.text.length };
    }), filesystemModified: false as const };
}

/** Exclusive output only. A cancelled/failed partial owned directory is preserved, never reported as a complete pair. */
export async function exportLongformSidecarBundleV1(runtime: LongformSidecarRuntimeV1, request: LongformSidecarExportRequestV1,
  options: LongformSidecarExportOptionsV1 = {}) {
  for (const digest of [request.expectedProjectSha256, request.expectedProjectFileSha256, request.expectedBundleSha256])
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("SIDECAR_EXPECTED_DIGEST");
  const current = await prepared(runtime, request);
  if (current.binding.projectSha256 !== request.expectedProjectSha256 || current.binding.projectFileSha256 !== request.expectedProjectFileSha256
    || current.bundleSha256 !== request.expectedBundleSha256) throw Error("SIDECAR_STALE_PREPARED_BINDING");
  const target = confined(current.root, request.outputDirectory), parents = await directoryPins(current.root, dirname(target));
  let created = false;
  const check = async () => {
    if (options.signal?.aborted) throw Error("SIDECAR_ABORTED");
    await verifyDirectories([...current.pins, ...parents]);
    const source = await readBoundedFile(current.projectPath, PROJECT_MAX_BYTES);
    if (sha(source) !== current.binding.projectFileSha256) throw Error("SIDECAR_SOURCE_CHANGED_DURING_EXPORT");
    if (options.signal?.aborted) throw Error("SIDECAR_ABORTED");
  };
  const phase = async (value: LongformSidecarPhaseV1) => { await options.onPhase?.(value); await check(); };
  try {
    await phase("before_directory");
    try { await mkdir(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("SIDECAR_OUTPUT_EXISTS: preserve existing output; select a new directory");
      throw error;
    }
    created = true;
    const targetPins = await directoryPins(current.root, target);
    await phase("directory_created");
    const written: Array<{ name: string; path: string; utf8Bytes: number; contentSha256: string }> = [];
    for (const [index, file] of current.files.entries()) {
      await check(); await verifyDirectories(targetPins);
      const path = join(target, file.name), handle = await open(path, "wx");
      try { await handle.writeFile(file.text, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await phase(index === 0 ? "captions_written" : "chapters_written"); await verifyDirectories(targetPins);
      const limit = file.name === "captions.srt" ? CAPTION_DELIVERY_LIMITS.outputBytes : LONGFORM_SIDECAR_LIMITS_V1.chapterBytes;
      const bytes = await readBoundedFile(path, limit);
      if (bytes.byteLength !== file.utf8Bytes || sha(bytes) !== file.contentSha256) throw Error("SIDECAR_OUTPUT_READBACK_MISMATCH");
      written.push({ name: file.name, path, utf8Bytes: bytes.byteLength, contentSha256: sha(bytes) });
    }
    // Re-read BOTH files after both writes. A first sidecar changed during the second write must not pass.
    for (const file of written) {
      await verifyDirectories(targetPins);
      const bytes = await readBoundedFile(file.path, file.utf8Bytes);
      if (bytes.byteLength !== file.utf8Bytes || sha(bytes) !== file.contentSha256) throw Error("SIDECAR_FINAL_PAIR_CHANGED");
    }
    await check(); await verifyDirectories(targetPins);
    return { status: "COMPLETE" as const, ...current.metadata, bundleSha256: current.bundleSha256, outputDirectory: target, files: written,
      completePairVerified: true as const, filesystemTransactionAtomic: false as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (created) throw Error(`SIDECAR_INCOMPLETE_OUTPUT: partial owned output preserved at ${target}; ${message}`);
    throw error;
  }
}
