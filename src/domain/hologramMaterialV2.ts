import * as z from "zod/v4";

export const hologramMaterialV2Schema = z.strictObject({
  schema:z.literal("editkin.hologram-material/v2"), seed:z.number().int().min(0).max(0xffffffff),
  colorLinear:z.tuple([z.number().finite().min(0).max(8),z.number().finite().min(0).max(8),z.number().finite().min(0).max(8)]),
  strength:z.number().finite().min(0).max(8),glowAmount:z.number().finite().min(0).max(8),bloomAmount:z.number().finite().min(0).max(8),
  glowRadius:z.number().int().min(0).max(32),bloomRadius:z.number().int().min(0).max(32),
  scanlinePeriod:z.number().int().min(2).max(64),scanlineAmount:z.number().finite().min(0).max(1),
  dispersionPixels:z.number().int().min(0).max(12),glitchMaxPixels:z.number().int().min(0).max(32),glitchBandHeight:z.number().int().min(1).max(64),
  flickerRateHz:z.number().finite().min(0).max(3),flickerDepth:z.number().finite().min(0).max(1),
});
export type HologramMaterialV2 = z.infer<typeof hologramMaterialV2Schema>;
export const HOLOGRAM_V2_MAX_PIXELS=1024*1024;
export function hologramSeedHashV2(value:number):number {
  let v=value>>>0;v^=v>>>16;v=Math.imul(v,0x7feb352d);v^=v>>>15;v=Math.imul(v,0x846ca68b);return(v^(v>>>16))>>>0;
}
/** Stateless frame addressing: no playback history, accumulated time, or random global state. */
export function hologramTemporalV2(material:HologramMaterialV2,frame:number,fps:number){
  if(!Number.isSafeInteger(frame)||frame<0||!Number.isFinite(fps)||fps<1||fps>240||frame/fps>86400)throw Error("HOLOGRAM_V2_CLOCK_BUDGET");
  const time=frame/fps,clock=time*material.flickerRateHz,slot=Math.floor(clock),phase=clock-slot;
  const pulse=material.flickerRateHz>0&&phase<.2?Math.sin(Math.PI*phase/.2)**2:0;
  const slotSeed=hologramSeedHashV2(material.seed^slot),depth=.5+.5*slotSeed/0xffffffff;
  return{time,slot,phase,pulse,gain:Math.fround(1-material.flickerDepth*depth*pulse),shiftLimit:Math.floor(material.glitchMaxPixels*pulse),slotSeed};
}

export interface HologramFrameInputV2 {width:number;height:number;coverage:Float32Array;baseLinearRgba:Float32Array;frame:number;fps:number;material:HologramMaterialV2}
export function validateHologramFrameV2(input:HologramFrameInputV2):HologramMaterialV2 {
  const{width,height,coverage,baseLinearRgba}=input,material=hologramMaterialV2Schema.parse(input.material);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>1024||height>1024||width*height>HOLOGRAM_V2_MAX_PIXELS
    ||!(coverage instanceof Float32Array)||!(baseLinearRgba instanceof Float32Array)||coverage.length!==width*height||baseLinearRgba.length!==width*height*4)throw Error("HOLOGRAM_V2_RASTER_BUDGET");
  for(let i=0;i<coverage.length;i++)if(!Number.isFinite(coverage[i])||coverage[i]<0||coverage[i]>1)throw Error("HOLOGRAM_V2_COVERAGE_INVALID");
  for(let i=0;i<baseLinearRgba.length;i++)if(!Number.isFinite(baseLinearRgba[i])||(i%4===3?baseLinearRgba[i]!==1:baseLinearRgba[i]<0||baseLinearRgba[i]>16))throw Error("HOLOGRAM_V2_OPAQUE_LINEAR_BASE_REQUIRED");
  hologramTemporalV2(material,input.frame,input.fps);return material;
}
