import { constants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isRenderWorkDirectoryName } from "./renderWorkspace";

export async function assertOwnedStreamWorkspaceV1(workspace: string): Promise<void> {
  const root = resolve(workspace);
  if (!isRenderWorkDirectoryName(basename(root))) throw Error("STREAM_WORK_OWNER_INVALID");
  for (let path = root;; path = dirname(path)) {
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw Error("STREAM_WORK_REPARSE_REFUSED");
    if (dirname(path) === path) break;
  }
  const path = join(root, ".editkin-render-work-owner.json"), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) throw Error("STREAM_WORK_OWNER_INVALID");
  const owner = JSON.parse(await readFile(path, "utf8"));
  if (owner.schema !== "editkin.render-work-owner/v1" || owner.pid !== process.pid || owner.host !== hostname()) throw Error("STREAM_WORK_OWNER_INVALID");
}

/** Sequential native PNG -> encoder pipe. A successfully consumed owned frame is removed immediately. */
export function createBoundedPngFrameSinkV1(input: { workspace: string; directory: string; width: number; height: number;
  startFrame: number; frameCount: number; maximumFrameBytes: number; signal: AbortSignal;
  write: (bytes: Uint8Array) => Promise<void> }) {
  const directory = resolve(input.directory), workspace = resolve(input.workspace);
  if (dirname(directory) !== workspace || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0
    || !Number.isSafeInteger(input.frameCount) || input.frameCount < 1
    || !Number.isSafeInteger(input.startFrame + input.frameCount)
    || !Number.isSafeInteger(input.maximumFrameBytes) || input.maximumFrameBytes < 33) throw Error("STREAM_FRAME_RANGE_INVALID");
  let count = 0, busy = false, peakFrameBytes = 0, totalPngBytes = 0;
  return {
    async consume(path: string, frame: number): Promise<void> {
      input.signal.throwIfAborted();
      const expected = input.startFrame + count;
      if (busy || frame !== expected || count >= input.frameCount
        || resolve(path) !== join(directory, `frame-${String(expected).padStart(8, "0")}.png`)) throw Error("STREAM_FRAME_ORDER_REFUSED");
      busy = true;
      try {
        await assertOwnedStreamWorkspaceV1(workspace);
        const dir = await lstat(directory); if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error("STREAM_FRAME_DIRECTORY_REFUSED");
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > input.maximumFrameBytes || before.size < 33) throw Error("STREAM_FRAME_SIZE_REFUSED");
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try {
          const bound = await handle.stat(); if (bound.ino !== before.ino || bound.dev !== before.dev || bound.size !== before.size) throw Error("STREAM_FRAME_IDENTITY_CHANGED");
          bytes = Buffer.alloc(before.size); let offset = 0;
          while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw Error("STREAM_FRAME_TRUNCATED"); offset += result.bytesRead; }
          if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8) !== 13
            || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== input.width
            || bytes.readUInt32BE(20) !== input.height || bytes[24] !== 8
            || ![2,6].includes(bytes[25]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw Error("STREAM_FRAME_PNG_CONTRACT_INVALID");
          input.signal.throwIfAborted(); await input.write(bytes); input.signal.throwIfAborted();
        } finally { await handle.close(); }
        const after = await lstat(path); if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.isSymbolicLink()) throw Error("STREAM_FRAME_IDENTITY_CHANGED");
        await assertOwnedStreamWorkspaceV1(workspace); await unlink(path);
        count++; totalPngBytes += bytes.length; peakFrameBytes = Math.max(peakFrameBytes, bytes.length);
      } finally { busy = false; }
    },
    assertComplete() { if (busy || count !== input.frameCount) throw Error("STREAM_FRAME_COUNT_MISMATCH"); },
    get receipt() { return { consumedFrames: count, totalPngBytes, peakFrameBytes, maximumPendingFrames: 1, retainedConsumedFrames: 0 }; },
  };
}
