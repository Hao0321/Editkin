import { effectiveClipFades } from "../domain/clipAudioEnvelope";
import type { TimelineClip } from "../domain/types";
const n=(value:number)=>{if(!Number.isFinite(value))throw Error("聲音參數不合法。");return value.toFixed(9).replace(/0+$/,"").replace(/\.$/,"");};
/** Clip-local filtering comes before delay. Legacy clips retain their existing caller's exact filter string. */
export function clipAudioEnvelopeFilter(clip:TimelineClip,music=false):string {
  if(!clip.audioEnvelope)return "";
  const parts:string[]=[],f=effectiveClipFades(clip,music);
  const nativeAfade=f.offset===0;
  if(nativeAfade){
    if(f.in>0)parts.push(`afade=t=in:st=0:d=${n(f.in)}:curve=tri`);
    if(f.out>0)parts.push(`afade=t=out:st=${n(f.duration-f.out)}:d=${n(f.out)}:curve=tri`);
  }
  const point=clip.audioEnvelope.volume;
  const t=point?`(n/s+${n(point.offset)})`:"n/s";
  let db=point?n(point.points.at(-1)!.db):"0";
  if(point){
    for(let i=point.points.length-2;i>=0;i--){const a=point.points[i],b=point.points[i+1];db=`if(lt(${t},${n(b.time)}),${n(a.db)}+(${t}-${n(a.time)})*${n((b.db-a.db)/(b.time-a.time))},${db})`;}
    db=`if(lte(${t},${n(point.points[0].time)}),${n(point.points[0].db)},${db})`;
  }
  const factors=point?[`pow(10,(${db})/20)`]:[];
  if(!nativeAfade){
    const pos=`(n/s+${n(f.offset)})`;
    if(f.in>0)factors.push(`clip(${pos}/${n(f.in)},0,1)`);
    if(f.out>0)factors.push(`clip((${n(f.duration)}-${pos})/${n(f.out)},0,1)`);
  }
  // aeval applies each sample, unlike frame-evaluated volume. Preserve both channels of the canonical stereo route.
  if(factors.length){const gain=factors.join("*");parts.push(`aeval=exprs='val(0)*(${gain})|val(1)*(${gain})'`);}
  return parts.length?","+parts.join(","):"";
}
