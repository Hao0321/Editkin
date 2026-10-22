const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 ** 2;
const CHUNK_BYTES = 64 * 1024;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const FILE_FIELDS = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
const DIRECTORY_FIELDS = ["dev", "ino", "mode"];
const same = (left, right, fields) => fields.every(field => left[field] === right[field]);

/** Synchronous equivalent of the validation reader: one handle, fixed cap, pre/post identities. */
function createModuleMetadataSyncReaderV3(io = fs) {
  function requireFile(info) {
    if (!info.isFile() || info.size < 0n || info.size > BigInt(MAX_BYTES)) {
      throw Error("MODULE_METADATA_INPUT_BUDGET: requires a bounded regular source file");
    }
  }

  function admit(targetInput) {
    const target = path.resolve(targetInput), rows = [];
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
      current = path.resolve(current, part);
      const info = io.lstatSync(current, { bigint: true });
      if (info.isSymbolicLink() || (current !== target && !info.isDirectory())) {
        throw Error("MODULE_METADATA_INPUT_PATH: links or non-directory ancestry");
      }
      rows.push({ path: current, info });
    }
    if (!rows.length) throw Error("MODULE_METADATA_INPUT_PATH: source file required");
    requireFile(rows.at(-1).info);
    return { target, rows };
  }

  function assertSame(before, after) {
    if (before.target !== after.target || before.rows.length !== after.rows.length || before.rows.some((row, index) => {
      const next = after.rows[index], fields = index === before.rows.length - 1 ? FILE_FIELDS : DIRECTORY_FIELDS;
      return row.path !== next.path || !same(row.info, next.info, fields);
    })) throw Error("MODULE_METADATA_INPUT_CHANGED: source path or identity changed");
  }

  function read(target, expected) {
    const beforePath = admit(target);
    if (expected) assertSame(expected, beforePath);
    const fd = io.openSync(beforePath.target, FLAGS);
    try {
      const before = io.fstatSync(fd, { bigint: true });
      requireFile(before);
      if (!same(beforePath.rows.at(-1).info, before, FILE_FIELDS)) {
        throw Error("MODULE_METADATA_INPUT_CHANGED: source changed before reading");
      }
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
      let total = 0;
      while (total <= MAX_BYTES) {
        const requested = Math.min(CHUNK_BYTES, buffer.length - total);
        const count = io.readSync(fd, buffer, total, requested, null);
        if (!Number.isSafeInteger(count) || count < 0 || count > requested) throw Error("MODULE_METADATA_INPUT_READ: invalid count");
        if (!count) break;
        total += count;
        if (total > MAX_BYTES) throw Error("MODULE_METADATA_INPUT_BUDGET: input grew beyond its budget");
      }
      const after = io.fstatSync(fd, { bigint: true });
      requireFile(after);
      if (!same(before, after, FILE_FIELDS) || BigInt(total) !== after.size) {
        throw Error("MODULE_METADATA_INPUT_CHANGED: source changed while reading");
      }
      assertSame(beforePath, admit(beforePath.target));
      return Buffer.from(buffer.subarray(0, total));
    } finally {
      io.closeSync(fd);
    }
  }
  return { admit, assertSame, read };
}

module.exports = { MODULE_METADATA_MAX_INPUT_BYTES_V3: MAX_BYTES, createModuleMetadataSyncReaderV3 };
