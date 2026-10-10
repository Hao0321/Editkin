import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assertLocalMediaPath } from "../shared/localMediaPath";

export const mediaDiscoveryInputSchema = z.object({
  directory: z.string().trim().min(1).max(1_024),
  query: z.string().max(160).default(""),
  kinds: z.array(z.enum(["video", "audio", "image"])).min(1).max(3).default(["video", "audio", "image"]),
  maxDepth: z.number().int().min(0).max(8).default(3),
  maxEntries: z.number().int().min(1).max(20_000).default(5_000),
  timeoutMs: z.number().int().min(100).max(10_000).default(8_000),
  limit: z.number().int().min(1).max(100).default(40),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export type MediaDiscoveryInput = z.input<typeof mediaDiscoveryInputSchema>;
export type MediaKindHint = "video" | "audio" | "image";
export interface DiscoveredMedia {
  sourcePath: string;
  name: string;
  kindHint: MediaKindHint;
  extension: string;
  bytes: number;
  modifiedAt: string;
  statFingerprint: string;
  verification: "EXTENSION_HINT_ONLY";
}
export interface MediaDiscoveryContext {
  workspaceRoot: string;
  signal?: AbortSignal;
  /** Internal clock seam; callers cannot inject it through MCP input. */
  now?: () => number;
}

const EXTENSIONS: Record<MediaKindHint, readonly string[]> = {
  video: [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts", ".m2ts", ".mpg", ".mpeg", ".ts", ".mxf"],
  audio: [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff", ".wma"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif", ".exr"],
};
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".editkin-receipts", ".editkin-cache"]);
const cursorSchema = z.object({ v: z.literal(1), request: z.string().regex(/^[a-f0-9]{64}$/), snapshot: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(20_000) }).strict();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const slash = (value: string) => value.split(sep).join("/");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function inside(root: string, path: string): void {
  const relation = relative(root, path);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("Media discovery path is outside the configured workspace");
}

async function selectedDirectory(root: string, input: string): Promise<string> {
  assertLocalMediaPath(input);
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw new Error("Media discovery requires a local directory path, not a URI");
  const target = resolve(root, input);
  inside(root, target);
  // Do not follow a junction/symlink supplied in any selected path component.
  let component = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    component = resolve(component, part);
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Media discovery does not follow symlinks or junctions");
  }
  if (!(await lstat(target)).isDirectory()) throw new Error("Media discovery requires an existing directory");
  const canonical = await realpath(target);
  assertLocalMediaPath(canonical);
  inside(await realpath(root), canonical);
  return target;
}

function parseCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch { throw new Error("Invalid media discovery cursor"); }
}

interface ScanState {
  visited: number;
  directories: number;
  skipped: { symlinks: number; excludedDirectories: number; deeperDirectories: number; emptyMedia: number; unsupportedFiles: number; specialFiles: number };
  files: DiscoveredMedia[];
  directoryStamps: unknown[];
}

/** Metadata supplier only. Actual byte hashing and stream probing remain in media bootstrap. */
export async function discoverWorkspaceMedia(raw: MediaDiscoveryInput, context: MediaDiscoveryContext) {
  const input = mediaDiscoveryInputSchema.parse(raw);
  const clock = context.now ?? Date.now;
  const deadline = clock() + input.timeoutMs;
  const check = () => {
    context.signal?.throwIfAborted();
    if (clock() >= deadline) throw new Error("Media discovery time budget exceeded; select a smaller folder");
  };
  check();
  const root = resolve(context.workspaceRoot);
  assertLocalMediaPath(root);
  const directory = await selectedDirectory(root, input.directory);
  const canonicalRoot = await realpath(root);
  assertLocalMediaPath(canonicalRoot);
  const canonicalDirectory = await realpath(directory);
  check();
  const kinds = [...new Set(input.kinds)].sort();
  const terms = normalize(input.query).trim().split(/\s+/).filter(Boolean);
  const request = sha({ root: canonicalRoot, directory: canonicalDirectory, terms, kinds, maxDepth: input.maxDepth, maxEntries: input.maxEntries, limit: input.limit });
  const cursor = parseCursor(input.cursor);
  if (cursor && cursor.request !== request) throw new Error("Media discovery cursor does not match this request");
  const state: ScanState = {
    visited: 0, directories: 0, files: [], directoryStamps: [],
    skipped: { symlinks: 0, excludedDirectories: 0, deeperDirectories: 0, emptyMedia: 0, unsupportedFiles: 0, specialFiles: 0 },
  };

  const visit = async (path: string, depth: number): Promise<void> => {
    check();
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Media discovery directory changed during scan");
    inside(canonicalRoot, await realpath(path));
    state.directories += 1;
    const directoryStamp = [slash(relative(root, path)), before.dev.toString(), before.ino.toString(), before.mtimeNs.toString()];
    state.directoryStamps.push(directoryStamp);
    const handle = await opendir(path, { bufferSize: 64 });
    for await (const entry of handle) {
      check();
      if (++state.visited > input.maxEntries) throw new Error("Media discovery entry budget exceeded; select a smaller folder or increase maxEntries (maximum 20000)");
      const candidate = resolve(path, entry.name);
      const stat = await lstat(candidate, { bigint: true });
      if (stat.isSymbolicLink()) { state.skipped.symlinks += 1; continue; }
      if (stat.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) state.skipped.excludedDirectories += 1;
        else if (depth === input.maxDepth) state.skipped.deeperDirectories += 1;
        else await visit(candidate, depth + 1);
        continue;
      }
      if (!stat.isFile()) { state.skipped.specialFiles += 1; continue; }
      const extension = extname(entry.name).toLowerCase();
      const kindHint = (Object.keys(EXTENSIONS) as MediaKindHint[]).find(kind => EXTENSIONS[kind].includes(extension));
      if (!kindHint) { state.skipped.unsupportedFiles += 1; continue; }
      if (stat.size === 0n) { state.skipped.emptyMedia += 1; continue; }
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Media discovery file size exceeds exact metadata range");
      inside(canonicalRoot, await realpath(candidate));
      const sourcePath = slash(relative(root, candidate));
      state.files.push({ sourcePath, name: entry.name, kindHint, extension, bytes: Number(stat.size),
        modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
        statFingerprint: sha([sourcePath, stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()]),
        verification: "EXTENSION_HINT_ONLY" });
    }
    const after = await lstat(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) throw new Error("Media discovery directory changed during scan; retry on a stable folder");
    inside(canonicalRoot, await realpath(path));
    check();
  };
  await visit(directory, 0);
  state.files.sort((a, b) => compare(a.sourcePath, b.sourcePath));
  state.directoryStamps.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const snapshot = sha({ files: state.files, directories: state.directoryStamps, skipped: state.skipped });
  if (cursor && cursor.snapshot !== snapshot) throw new Error("Media discovery inventory changed; start a new scan without the cursor");
  const matched = state.files.filter(file => kinds.includes(file.kindHint) && terms.every(term => normalize(file.sourcePath).includes(term)));
  const offset = cursor?.offset ?? 0;
  if (offset > matched.length) throw new Error("Media discovery cursor offset is outside this inventory");
  const results = matched.slice(offset, offset + input.limit);
  const nextOffset = offset + results.length;
  const nextCursor = nextOffset < matched.length ? Buffer.from(JSON.stringify({ v: 1, request, snapshot, offset: nextOffset })).toString("base64url") : null;
  check();
  return {
    status: "DISCOVERED_METADATA_ONLY" as const, directory: slash(relative(root, directory)) || ".", results, totalMatched: matched.length,
    nextCursor, inventorySha256: snapshot, visitedEntries: state.visited, directoriesScanned: state.directories, skipped: state.skipped,
    completeWithinDepth: state.skipped.symlinks === 0 && state.skipped.excludedDirectories === 0 && state.skipped.deeperDirectories === 0,
    excludedDirectoryNames: [...EXCLUDED_DIRECTORIES], elapsedMs: Math.max(0, clock() - (deadline - input.timeoutMs)),
    projectModified: false as const, artworkAccepted: false as const, metadataOnly: true as const,
    nextStep: "Use a selected sourcePath with prepare_media_bootstrap; bootstrap performs actual stream probing and byte identity checks" as const,
    capabilityBoundary: "Extension/stat hints only; not codec, visual semantics, byte SHA, import lease, rights verification or output acceptance. This is an observed inventory, not an atomic filesystem snapshot." as const,
  };
}
