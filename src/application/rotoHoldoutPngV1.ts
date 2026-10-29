import { PNG } from "pngjs";
import { ROTO_HOLDOUT_MAX_PIXELS_V1 } from "./rotoHoldoutLabelKitV1";

/** Check the untrusted header before PNGJS allocates its raster; PNGJS also checks CRC/deflate consistency. */
export function readRotoHoldoutPngV1(bytes: Buffer, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width * height > ROTO_HOLDOUT_MAX_PIXELS_V1
    || bytes.length < 45 || bytes.length > width * height * 4 + 65536
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height || bytes[24] !== 8
    || ![0, 2, 4, 6].includes(bytes[25]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw Error("ROTO_HOLDOUT_PNG_CONTRACT_INVALID");
  const image = PNG.sync.read(bytes);
  if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) throw Error("ROTO_HOLDOUT_PNG_RASTER_INVALID");
  return image;
}
export function blankRotoHoldoutPngV1(width: number, height: number) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n >= 2) || width * height > ROTO_HOLDOUT_MAX_PIXELS_V1) throw Error("ROTO_HOLDOUT_PNG_SIZE_INVALID");
  const data = Buffer.alloc(width * height * 4); for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return PNG.sync.write({ width, height, data });
}
/** A mask uses opaque, equal RGB channels. Image alpha is never silently mistaken for the label plane. */
export function rotoHoldoutAlpha8V1(bytes: Buffer, width: number, height: number) {
  const image = readRotoHoldoutPngV1(bytes, width, height), alpha = Buffer.alloc(width * height); let allBackground = true;
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4, value = image.data[p];
    if (image.data[p + 1] !== value || image.data[p + 2] !== value || image.data[p + 3] !== 255) throw Error("ROTO_HOLDOUT_OPAQUE_GRAYSCALE_MASK_REQUIRED");
    alpha[i] = value; if (value) allBackground = false;
  }
  return { alpha, allBackground };
}
