import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

// O_NOFOLLOW and O_NONBLOCK are undefined on Windows; there the callers'
// own lstat symlink checks remain the guard. NONBLOCK keeps a path swapped for
// a FIFO from hanging open() before the type check below can reject it.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Reads a regular file through ONE handle. The type check runs on that handle
 * (fstat), so the path cannot be swapped for a symlink or device between a
 * separate stat/lstat and the read, and a reported size or hash always
 * describes the bytes actually read.
 */
export async function readRegularFile(path) {
  const handle = await open(path, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** `{ bytes, sha256 }` of one regular file, both taken from a single read. */
export async function fileIdentity(path) {
  const bytes = await readRegularFile(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
