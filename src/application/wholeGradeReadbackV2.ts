import { createHash } from "node:crypto";

/** Opaque colour atlas transport. Keep FFmpeg's planar alpha until host readback;
 * removing gbrap16le alpha through this pinned FFmpeg's gbrp16le conversion corrupts tail pixels.
 * Dropping the fourth plane here is a byte view, with no RGB conversion or rounding.
 */
export function wholeGradeRgba16ReadbackV2(bytes:Uint8Array,pixels:number) {
  const colourBytes=pixels*6,transportBytes=pixels*8;
  if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||(bytes.buffer as ArrayBuffer&{resizable?:boolean}).resizable
    ||!Number.isSafeInteger(pixels)||pixels<1||!Number.isSafeInteger(transportBytes)||transportBytes>16*1024**2||bytes.byteLength!==transportBytes)
    throw Error("WHOLE_GRADE_RGBA16_READBACK_BUDGET");
  for(let i=colourBytes;i<bytes.length;i++)if(bytes[i]!==255)throw Error("WHOLE_GRADE_RGBA16_READBACK_NOT_OPAQUE");
  const rgb=bytes.subarray(0,colourBytes),sha=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
  return {bytes:rgb,receipt:{schema:"editkin.whole-grade-rgba16-readback/v2" as const,pixelFormat:"gbrap16le" as const,
    pixels,transportBytes,colourBytes,alphaOpaque:true as const,transportSha256:sha(bytes),colourSha256:sha(rgb)}};
}
