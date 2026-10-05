import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { bundledFontFaceSpec, type BundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { assertLocalMediaPath } from "../shared/localMediaPath";

const MAX_FONT_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
interface DirectoryIdentity { readonly path: string; readonly stat: Stats; }
interface FileReceipt { readonly bytes: Buffer; readonly stat: Stats; }

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}
function sameFile(left: Stats, right: Stats): boolean {
  return sameObject(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("Bundled font directory is not a fixed regular directory");
  }
  return { path, stat };
}

/** Parent junctions are rejected as well as a linked root/render directory. */
async function directoryChain(root: string): Promise<DirectoryIdentity[]> {
  const anchor = parse(root).root;
  const directories = [await directoryIdentity(anchor)];
  let current = anchor;
  for (const component of relative(anchor, root).split(sep).filter(Boolean)) {
    current = join(current, component);
    directories.push(await directoryIdentity(current));
  }
  directories.push(await directoryIdentity(join(root, "render")));
  return directories;
}

async function assertDirectoriesUnchanged(directories: readonly DirectoryIdentity[]): Promise<void> {
  for (const before of directories) {
    const after = await directoryIdentity(before.path);
    if (!sameObject(before.stat, after.stat)) throw new Error("Bundled font directory changed during read");
  }
}

async function readFixedFile(path: string, limit: number, label: string): Promise<FileReceipt> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`${label} is not a fixed regular file`);
  }
  if (before.size <= 0 || before.size > limit) throw new Error(`${label} exceeds its bounded size`);
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`${label} changed before read`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error(`${label} changed during read`);
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, offset);
    const after = await handle.stat(), atPath = await lstat(path);
    if (extra.bytesRead !== 0 || !sameFile(opened, after) || !atPath.isFile() || atPath.isSymbolicLink()
      || !sameFile(opened, atPath) || !samePath(await realpath(path), path)) {
      throw new Error(`${label} changed during read`);
    }
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

function manifestFaceSize(bytes: Uint8Array, spec: BundledFontFaceSpec): number {
  if (digest(bytes) !== spec.manifestSha256) throw new Error("Bundled font manifest SHA does not match compiled catalog");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    schemaVersion?: unknown;
    fonts?: Array<{ id?: unknown; family?: unknown; faces?: Array<{ id?: unknown; weight?: unknown; file?: unknown; family?: unknown; bytes?: unknown; sha256?: unknown }> }>;
  };
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.fonts) || manifest.fonts.length !== 5) {
    throw new Error("Bundled font manifest schema is invalid");
  }
  const matches = manifest.fonts.flatMap(font => Array.isArray(font.faces)
    ? font.faces.filter(face => face.id === spec.faceId).map(face => ({ font, face })) : []);
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!selected || typeof selected.font.id !== "string" || typeof selected.font.family !== "string" || !selected.font.family.trim()
    || `EditkinFace-${selected.font.id}-${spec.fontWeight}` !== spec.faceId
    || selected.face.file !== spec.fontFile || selected.face.family !== spec.fontFamily || selected.face.weight !== spec.fontWeight
    || selected.face.sha256 !== spec.sha256 || !Number.isSafeInteger(selected.face.bytes)
    || (selected.face.bytes as number) <= 0 || (selected.face.bytes as number) > MAX_FONT_BYTES) {
    throw new Error("Bundled physical font manifest fields disagree with compiled catalog");
  }
  return selected.face.bytes as number;
}

/** Request selects an already compiled face, never a path, URL or trusted digest. */
export async function readBundledFontFace(root: string, faceId: string): Promise<Uint8Array> {
  const spec = bundledFontFaceSpec(faceId); // Reject unknown identities before any filesystem I/O.
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Bundled font root must be absolute");
  assertLocalMediaPath(root);
  const fixedRoot = resolve(root), directories = await directoryChain(fixedRoot);
  const manifestPath = join(fixedRoot, "editkin-open-fonts.json");
  const manifestBefore = await readFixedFile(manifestPath, MAX_MANIFEST_BYTES, "Bundled font manifest");
  const expectedSize = manifestFaceSize(manifestBefore.bytes, spec);
  await assertDirectoriesUnchanged(directories);
  const target = join(fixedRoot, spec.fontFile);
  const font = await readFixedFile(target, MAX_FONT_BYTES, "Bundled physical font");
  if (font.bytes.length !== expectedSize || digest(font.bytes) !== spec.sha256) throw new Error("Bundled physical font size or SHA does not match compiled catalog");
  // Re-read the pinned manifest: a replacement after its first closed handle
  // must not authorize a font delivered from a different pack generation.
  const manifestAfter = await readFixedFile(manifestPath, MAX_MANIFEST_BYTES, "Bundled font manifest");
  if (!sameFile(manifestBefore.stat, manifestAfter.stat) || !manifestBefore.bytes.equals(manifestAfter.bytes)) {
    throw new Error("Bundled font manifest changed during selected face read");
  }
  const finalFont = await lstat(target);
  if (!finalFont.isFile() || finalFont.isSymbolicLink() || !sameFile(font.stat, finalFont)) throw new Error("Bundled physical font changed after read");
  await assertDirectoriesUnchanged(directories);
  return new Uint8Array(font.bytes);
}
