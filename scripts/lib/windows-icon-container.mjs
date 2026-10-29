/** Tauri's Windows context decodes ICO entry zero. PE resources alone do not prove its window icon. */
export function windowsIconEntriesV1(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new Error("WINDOW_ICON_CONTAINER_INVALID");
  }
  const count = bytes.readUInt16LE(4), entries = [];
  if (count < 1 || count > 32 || bytes.length < 6 + count * 16) throw new Error("WINDOW_ICON_DIRECTORY_INVALID");
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16, length = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12);
    if (!length || start < 6 + count * 16 || start + length > bytes.length
      || entries.some(entry => start < entry.start + entry.length && entry.start < start + length)) {
      throw new Error("WINDOW_ICON_FRAME_RANGE_INVALID");
    }
    entries.push({ width: bytes[offset] || 256, height: bytes[offset + 1] || 256, start, length,
      directory: bytes.subarray(offset, offset + 16), encoded: bytes.subarray(start, start + length) });
  }
  return entries;
}
export function assertWindowIconResolutionV1(bytes) {
  const entries = windowsIconEntriesV1(bytes), first = entries[0];
  if (first.width !== 256 || first.height !== 256) throw new Error("WINDOW_ICON_DEFAULT_FRAME_MUST_BE_256");
  return { width: first.width, height: first.height, frames: entries.length };
}
