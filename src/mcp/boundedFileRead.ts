// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Read only the file opened and validated by this operation, even if its pathname is replaced. */
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function checkOpenFile(path: string, root: string, descriptor: number, limit: number): number {
  const canonicalRoot = realpathSync(root);
  const canonicalFile = realpathSync(path);
  const relation = relative(canonicalRoot, canonicalFile);
  const opened = fstatSync(descriptor);
  const current = statSync(canonicalFile);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
    || !opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
    || !Number.isSafeInteger(opened.size) || opened.size > limit || opened.size < 0) {
    throw Error("Bounded file is outside its root, changed, or too large");
  }
  return opened.size;
}

function checkUnchanged(descriptor: number, size: number, mtimeMs: number): void {
  const current = fstatSync(descriptor);
  if (current.size !== size || current.mtimeMs !== mtimeMs) throw Error("Bounded file changed during read");
}

export function readBoundedFileSync(path: string, root: string, limit: number): Buffer {
  const descriptor = openSync(path, readFlags);
  try {
    const size = checkOpenFile(path, root, descriptor, limit);
    const mtimeMs = fstatSync(descriptor).mtimeMs;
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (!count) throw Error("Bounded file was truncated during read");
      offset += count;
    }
    checkUnchanged(descriptor, size, mtimeMs);
    return bytes;
  } finally { closeSync(descriptor); }
}

export async function readBoundedFile(path: string, root: string, limit: number): Promise<Buffer> {
  const handle = await open(path, readFlags);
  try {
    const size = checkOpenFile(path, root, handle.fd, limit);
    const mtimeMs = (await handle.stat()).mtimeMs;
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw Error("Bounded file was truncated during read");
      offset += bytesRead;
    }
    checkUnchanged(handle.fd, size, mtimeMs);
    return bytes;
  } finally { await handle.close(); }
}
