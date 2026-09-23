import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function filesUnder(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push({ absolute, relative: relative(root, absolute).split(sep).join("/") });
      else throw new Error(`Deterministic ZIP rejects non-file entry: ${absolute}`);
    }
  }
  await visit(root);
  return output;
}

function u16(buffer, offset, value) { buffer.writeUInt16LE(value, offset); }
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createDeterministicZip({ sourceRoot, archiveRootName, outputPath }) {
  const root = resolve(sourceRoot);
  if (!/^[a-z0-9._-]+$/i.test(archiveRootName)) throw new Error("archiveRootName must be one safe path component");
  const files = await filesUnder(root);
  if (!files.length) throw new Error("Deterministic ZIP source is empty");
  if (files.length > 0xffff) throw new Error("ZIP64 is not supported by this deterministic writer");
  const output = resolve(outputPath);
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  let handle;
  try {
    handle = await open(temporary, "wx");
    let position = 0;
    const central = [];
    const write = async (buffer) => {
      await handle.write(buffer, 0, buffer.length, position);
      position += buffer.length;
    };
    for (const file of files) {
      const bytes = await readFile(file.absolute);
      if (bytes.length > 0xffffffff || position > 0xffffffff) throw new Error("ZIP64 is not supported by this deterministic writer");
      const name = Buffer.from(`${archiveRootName}/${file.relative}`, "utf8");
      const checksum = crc32(bytes);
      const offset = position;
      const header = Buffer.alloc(30);
      u32(header, 0, 0x04034b50);
      u16(header, 4, 20);
      u16(header, 6, 0x0800);
      u16(header, 8, 0);
      u16(header, 10, 0);
      u16(header, 12, 0x2821);
      u32(header, 14, checksum);
      u32(header, 18, bytes.length);
      u32(header, 22, bytes.length);
      u16(header, 26, name.length);
      u16(header, 28, 0);
      await write(header);
      await write(name);
      await write(bytes);
      central.push({ name, checksum, size: bytes.length, offset });
    }

    const centralOffset = position;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      u32(header, 0, 0x02014b50);
      u16(header, 4, 20);
      u16(header, 6, 20);
      u16(header, 8, 0x0800);
      u16(header, 10, 0);
      u16(header, 12, 0);
      u16(header, 14, 0x2821);
      u32(header, 16, entry.checksum);
      u32(header, 20, entry.size);
      u32(header, 24, entry.size);
      u16(header, 28, entry.name.length);
      u16(header, 30, 0);
      u16(header, 32, 0);
      u16(header, 34, 0);
      u16(header, 36, 0);
      u32(header, 38, 0);
      u32(header, 42, entry.offset);
      await write(header);
      await write(entry.name);
    }
    const centralSize = position - centralOffset;
    if (position > 0xffffffff || centralSize > 0xffffffff) throw new Error("ZIP64 is not supported by this deterministic writer");
    const end = Buffer.alloc(22);
    u32(end, 0, 0x06054b50);
    u16(end, 4, 0);
    u16(end, 6, 0);
    u16(end, 8, central.length);
    u16(end, 10, central.length);
    u32(end, 12, centralSize);
    u32(end, 16, centralOffset);
    u16(end, 20, 0);
    await write(end);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rm(output, { force: true });
    await rename(temporary, output);
    return { output, files: files.length, bytes: position, sha256: await hashFile(output) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
