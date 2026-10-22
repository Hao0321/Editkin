import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parse, resolve } from "node:path";

export const MODULE_METADATA_MAX_INPUT_BYTES_V3 = 2 * 1024 ** 2;
const CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FILE_FIELDS = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
const DIRECTORY_FIELDS = ["dev", "ino", "mode"];

function sameStat(before, after, fields = FILE_FIELDS) {
  return fields.every(field => before[field] === after[field]);
}

function requireBoundedFile(info, limit) {
  if (!info.isFile() || info.size < 0n || info.size > BigInt(limit)) {
    throw Error("Module metadata validation requires a bounded regular source file");
  }
}

/** Reads at most limit+1 bytes even if the file grows after its admitted stat. */
export async function readModuleMetadataHandleV3(handle, expected, limit = MODULE_METADATA_MAX_INPUT_BYTES_V3) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MODULE_METADATA_MAX_INPUT_BYTES_V3) {
    throw Error("Invalid module metadata read budget");
  }
  const before = await handle.stat({ bigint: true });
  requireBoundedFile(before, limit);
  if (!sameStat(expected, before)) throw Error("Module metadata input changed before reading");
  const buffer = Buffer.allocUnsafe(limit + 1);
  let total = 0;
  while (total <= limit) {
    const requested = Math.min(CHUNK_BYTES, buffer.length - total);
    const { bytesRead } = await handle.read(buffer, total, requested, null);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
      throw Error("Invalid module metadata bounded read result");
    }
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw Error("Module metadata validation input grew beyond its budget");
  }
  const after = await handle.stat({ bigint: true });
  requireBoundedFile(after, limit);
  if (!sameStat(before, after) || BigInt(total) !== after.size) {
    throw Error("Module metadata input changed while reading");
  }
  return buffer.subarray(0, total);
}

async function capturePlainPath(target, statPath) {
  const rows = [];
  let current = parse(target).root;
  for (const part of target.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, part);
    const info = await statPath(current, { bigint: true });
    if (info.isSymbolicLink() || (current !== target && !info.isDirectory())) {
      throw Error("Module metadata validation rejects links or non-directory ancestry");
    }
    rows.push({ path: current, info });
  }
  const leaf = rows.at(-1)?.info;
  if (!leaf) throw Error("Module metadata validation requires a source file path");
  requireBoundedFile(leaf, MODULE_METADATA_MAX_INPUT_BYTES_V3);
  return rows;
}

/** Injectable filesystem boundary for deterministic handle/path race controls. */
export function createModuleMetadataReaderV3(io) {
  return async function readModuleMetadataFileV3(targetInput) {
    const target = resolve(targetInput);
    const beforePath = await capturePlainPath(target, io.lstat);
    const expected = beforePath.at(-1).info;
    const handle = await io.open(target, READ_FLAGS);
    try {
      const bytes = await readModuleMetadataHandleV3(handle, expected);
      const afterPath = await capturePlainPath(target, io.lstat);
      if (beforePath.length !== afterPath.length || beforePath.some((row, index) => {
        const after = afterPath[index];
        const fields = index === beforePath.length - 1 ? FILE_FIELDS : DIRECTORY_FIELDS;
        return row.path !== after.path || !sameStat(row.info, after.info, fields);
      })) {
        throw Error("Module metadata input path or ancestry changed while reading");
      }
      return Buffer.from(bytes);
    } finally {
      await handle.close();
    }
  };
}

// Windows has no O_NOFOLLOW: pre/post ancestry checks reject observed link swaps.
// The unconditional byte cap does not depend on path stability or reported size.
export const readModuleMetadataFileV3 = createModuleMetadataReaderV3({ open, lstat });
