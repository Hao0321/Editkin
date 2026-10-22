import type { compileColorWindowGeometryV1, ColorWindowGeometryV1 } from "../domain/colorWindowGeometryV1";
import { colorWindowCoverageV1 } from "../domain/colorWindowCoverageV1";
import { COLOR_WINDOW_LIMITS_V1, colorWindowRefuseV1 } from "../domain/colorWindowV1";

export interface ColorWindowRasterOptionsV1 { maximum?:255|65535; maximumBytes?:number; signal?:AbortSignal; }
/** One bounded grayscale frame, grey8 or gray16le, shared by export-plane consumers and reference tests. */
export function colorWindowRasterV1(geometry:ColorWindowGeometryV1,options:ColorWindowRasterOptionsV1={}):Buffer {
  const maximum=options.maximum??65535,byteDepth=maximum===255?1:2,limit=options.maximumBytes??COLOR_WINDOW_LIMITS_V1.rasterBytes;
  const {width,height}=geometry,bytes=width*height*byteDepth;
  if (![255,65535].includes(maximum) || ![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=32768)
    || !Number.isSafeInteger(limit) || limit<1 || limit>COLOR_WINDOW_LIMITS_V1.rasterBytes || !Number.isSafeInteger(bytes) || bytes>limit) colorWindowRefuseV1("COLOR_WINDOW_RASTER_BUDGET",geometry.maskId);
  options.signal?.throwIfAborted();
  const output=Buffer.alloc(bytes);
  if (geometry.status==="lost") return output;
  for(let y=0;y<height;y++) {
    if (y%64===0) options.signal?.throwIfAborted();
    for(let x=0;x<width;x++) {
      const value=Math.round(maximum*colorWindowCoverageV1(geometry,x+.5,y+.5)),index=(y*width+x)*byteDepth;
      if (byteDepth===1) output[index]=value;else output.writeUInt16LE(value,index);
    }
  }
  options.signal?.throwIfAborted();return output;
}
/** Pull one frame at a time. Neither disk usage nor the module's live memory grows with clip duration. */
export async function* colorWindowRasterFramesV1(geometry:ReturnType<typeof compileColorWindowGeometryV1>,
  input:ColorWindowRasterOptionsV1&{startFrame:number;frameCount:number;fps:number}) {
  if (!Number.isSafeInteger(input.startFrame)||input.startFrame<0||!Number.isSafeInteger(input.frameCount)||input.frameCount<0
    || !Number.isSafeInteger(input.startFrame+input.frameCount)||!Number.isFinite(input.fps)||input.fps<=0||input.fps>240) colorWindowRefuseV1("COLOR_WINDOW_PARAMETERS",geometry.maskId);
  for(let index=0;index<input.frameCount;index++) {
    input.signal?.throwIfAborted();
    const frame=input.startFrame+index,localSeconds=frame/input.fps,resolved=geometry.at(localSeconds);
    yield {frame,localSeconds,status:resolved.status,reason:resolved.reason,bytes:colorWindowRasterV1(resolved,input)};
  }
}
