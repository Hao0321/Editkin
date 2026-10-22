import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";

const refuse = (message: string): never => { throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", message); };
const fileName = (frame: number) => `frame-${String(frame).padStart(8, "0")}.png`;

/** Only the caller's freshly owned batch directory; check the entire file set and fixed headers before relaying any frame. */
export async function inspectSceneLinearChunkFilesV1(input: {
  directory: string; startFrame: number; frameCount: number; width: number; height: number; bitDepth: 8 | 16;
  maximumFrameBytes: number; maximumBatchBytes: number; expectedBytes: number;
  nativeReceipt?: { value: unknown; maximumBytes: number };
}) {
  if (![input.startFrame, input.frameCount, input.width, input.height, input.maximumFrameBytes, input.maximumBatchBytes, input.expectedBytes]
    .every(Number.isSafeInteger) || input.startFrame < 0 || input.frameCount < 1 || input.width < 1 || input.height < 1
    || input.maximumFrameBytes < 33 || input.maximumBatchBytes < input.maximumFrameBytes || input.expectedBytes < 33
    || input.startFrame + input.frameCount > 100_000_000 || ![8, 16].includes(input.bitDepth)) refuse("scene-linear file inspection budget or frame range is invalid");
  const directory = await lstat(input.directory, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) refuse("scene-linear batch is not an owned real directory");
  const entries = await readdir(input.directory, { withFileTypes: true });
  if (entries.length !== input.frameCount + (input.nativeReceipt ? 1 : 0)) refuse("scene-linear batch has missing or extra frame files");
  const names = new Set(entries.map(entry => entry.name));
  const identities: Array<{ dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }> = [];
  const same = (a: typeof identities[number], b: typeof identities[number]) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
  const manifestPath = join(input.directory, "editkin-ocio-display-sequence.json");
  let manifest: typeof identities[number] | undefined;
  if (input.nativeReceipt) {
    const maximum = input.nativeReceipt.maximumBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !names.has("editkin-ocio-display-sequence.json")) refuse("scene-linear native receipt file is missing or its budget is invalid");
    const info = await lstat(manifestPath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > BigInt(maximum)) refuse("scene-linear native receipt file is linked, empty or oversized");
    const file = await open(manifestPath, "r");
    try {
      if (!same(info, await file.stat({ bigint: true }))) refuse("scene-linear native receipt file changed while opening");
      const content = await file.readFile();
      if (BigInt(content.length) !== info.size || !same(info, await file.stat({ bigint: true }))) refuse("scene-linear native receipt file changed while reading");
      let value: unknown;
      try { value = JSON.parse(content.toString("utf8")); } catch { refuse("scene-linear native receipt file is invalid JSON"); }
      if (!isDeepStrictEqual(value, input.nativeReceipt.value)) refuse("scene-linear native receipt file differs from the child receipt");
    } finally { await file.close(); }
    manifest = { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
  }
  let bytes = 0;
  for (let offset = 0; offset < input.frameCount; offset++) {
    const name = fileName(input.startFrame + offset), path = join(input.directory, name);
    if (!names.has(name)) refuse("scene-linear batch frame order or absolute index is wrong");
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size < 33n || info.size > BigInt(input.maximumFrameBytes)) {
      refuse("scene-linear frame is linked, oversized or empty");
    }
    const header = Buffer.alloc(29), file = await open(path, "r");
    try {
      if (!same(info, await file.stat({ bigint: true }))) refuse("scene-linear frame changed while opening its header");
      const read = await file.read(header, 0, header.length, 0);
      if (read.bytesRead !== header.length || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR"
        || header.readUInt32BE(16) !== input.width || header.readUInt32BE(20) !== input.height
        || header[24] !== input.bitDepth || header[25] !== 6 || header[26] !== 0 || header[27] !== 0 || header[28] !== 0) {
        refuse("scene-linear PNG dimensions, channel precision or header differs from the requested display image");
      }
      if (!same(info, await file.stat({ bigint: true }))) refuse("scene-linear frame changed while reading its header");
    } finally { await file.close(); }
    identities.push({ dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs });
    bytes += Number(info.size);
    if (bytes > input.maximumBatchBytes) refuse("scene-linear batch exceeds its measured staging budget");
  }
  if (bytes !== input.expectedBytes) refuse("scene-linear PNG bytes differ from the native receipt");
  return { files: input.frameCount, bytes, manifestBytes: Number(manifest?.size ?? 0n),
    async retireManifest() {
      if (!manifest) return;
      const info = await lstat(manifestPath, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || !same(manifest, info)) refuse("scene-linear native receipt file changed before retirement");
      await unlink(manifestPath);
    },
    async consume(offset: number, write: (bytes: Uint8Array) => Promise<void>) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= input.frameCount) refuse("scene-linear frame offset is outside the batch");
      const currentDirectory = await lstat(input.directory, { bigint: true });
      if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) refuse("scene-linear batch directory changed after validation");
      const path = join(input.directory, fileName(input.startFrame + offset)), info = await lstat(path, { bigint: true }), expected = identities[offset];
      if (!info.isFile() || info.isSymbolicLink() || !same(expected, info)) refuse("scene-linear frame changed after validation");
      const file = await open(path, "r");
      let frame: Buffer;
      try {
        if (!same(expected, await file.stat({ bigint: true }))) refuse("scene-linear frame was substituted while opening");
        frame = await file.readFile();
        if (BigInt(frame.length) !== expected.size || !same(expected, await file.stat({ bigint: true }))) refuse("scene-linear frame changed while reading");
      } finally { await file.close(); }
      await write(frame);
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !same(expected, current)) refuse("scene-linear frame changed before retirement");
      await unlink(path); return frame.length;
    } };
}
