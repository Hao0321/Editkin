import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";

export interface BoundedFileOptions {
  /** Default false: a symlink/reparse final component is rejected. */
  followSymlinks?: boolean;
  /** Override caller-facing messages so existing diagnostics stay stable. */
  messages?: { notRegular?: string; tooLarge?: string; changed?: string };
}

const READ_ONLY = constants.O_RDONLY;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
// A path switched to a FIFO must not block open before fstat can reject it.
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;
const DEFAULT_MESSAGES = {
  notRegular: "path is not a regular file",
  tooLarge: "file exceeds its size limit",
  changed: "file changed while it was being read",
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertBound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
}

/**
 * Reads a regular file through ONE open handle. Size and file type are checked
 * with fstat on that handle, not on a path that can be swapped before the read,
 * and the read is bounded by the size observed on the handle.
 */
export async function readBoundedFile(path: string, maxBytes: number, options: BoundedFileOptions = {}): Promise<Buffer> {
  assertBound(maxBytes);
  const text = { ...DEFAULT_MESSAGES, ...options.messages };
  const followed = options.followSymlinks === true;
  const before = followed ? undefined : await lstat(path);
  if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error(text.notRegular);
  const handle = await open(path, READ_ONLY | NON_BLOCKING | (followed ? 0 : NO_FOLLOW));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(text.notRegular);
    if (before && !sameIdentity(before, opened)) throw new Error(text.changed);
    if (opened.size > maxBytes) throw new Error(text.tooLarge);
    const buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error(text.changed);
      offset += bytesRead;
    }
    // One extra byte proves the file did not grow past the size that was bounded.
    const probe = await handle.read(Buffer.allocUnsafe(1), 0, 1, offset);
    const after = await handle.stat();
    if (probe.bytesRead !== 0 || after.size !== opened.size || !sameIdentity(after, opened)) throw new Error(text.changed);
    return buffer;
  } finally {
    await handle.close();
  }
}

export function readBoundedFileSync(path: string, maxBytes: number, options: BoundedFileOptions = {}): Buffer {
  assertBound(maxBytes);
  const text = { ...DEFAULT_MESSAGES, ...options.messages };
  const followed = options.followSymlinks === true;
  const before = followed ? undefined : lstatSync(path);
  if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error(text.notRegular);
  const descriptor = openSync(path, READ_ONLY | NON_BLOCKING | (followed ? 0 : NO_FOLLOW));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(text.notRegular);
    if (before && !sameIdentity(before, opened)) throw new Error(text.changed);
    if (opened.size > maxBytes) throw new Error(text.tooLarge);
    const buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error(text.changed);
      offset += bytesRead;
    }
    const probe = readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, offset);
    const after = fstatSync(descriptor);
    if (probe !== 0 || after.size !== opened.size || !sameIdentity(after, opened)) throw new Error(text.changed);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}
