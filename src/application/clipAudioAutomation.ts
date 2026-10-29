import { clipAudioGainAt, effectiveClipFades } from "../domain/clipAudioEnvelope";
import type { TimelineClip } from "../domain/types";
const RATE=48000;
export interface ClipAudioGainPoint { sample:number;valueDb:number }
/** Log-spaced linear-dB chords approximate the authored linear-amplitude fades within the native 64-point contract. */
export function buildClipAudioGainAutomation(clip:TimelineClip,{music=false,startSeconds=0,durationSeconds=clip.duration,timelineDelay=clip.timelineStart}: {
  music?:boolean;startSeconds?:number;durationSeconds?:number;timelineDelay?:number;
}={}):ClipAudioGainPoint[] {
  const length=Math.max(1,Math.round(durationSeconds*RATE)),last=length-1,begin=Math.round(timelineDelay*RATE);
  const candidates=new Set<number>([0,last]),add=(local:number)=>{
    const exact=(local-startSeconds)*RATE;
    for(const sample of [Math.floor(exact),Math.ceil(exact)])if(sample>=0&&sample<=last)candidates.add(sample);
  };
  const fades=effectiveClipFades(clip,music);
  for(const point of clip.audioEnvelope?.volume?.points??[])add(point.time-(clip.audioEnvelope?.volume?.offset??0));
  const inStart=-fades.offset,inEnd=fades.in-fades.offset,outStart=fades.duration-fades.out-fades.offset,outEnd=fades.duration-fades.offset;
  for(const value of [inStart,inEnd,outStart,outEnd])add(value);
  // From one real sample onwards, ratios <=2 give a maximum chord error below 0.52 dB. Nonoverlapping authored fades
  // share that bound, while dB volume segments are exact. Keep the zero sample as -144 dB (the native silence floor).
  for(const [lengthSeconds,edge,sign] of [[fades.in,inStart,1],[fades.out,outEnd,-1]] as const){
    if(lengthSeconds<=0)continue;
    for(let sample=1;sample<lengthSeconds*RATE;sample*=2)add(edge+sign*sample/RATE);
    add(edge+sign*3/RATE);
  }
  const dense=[...candidates].sort((a,b)=>a-b).map(sample=>({sample:begin+sample,valueDb:Math.max(-144,Math.min(48,20*Math.log10(Math.max(10**(-144/20),clipAudioGainAt(clip,startSeconds+sample/RATE,music)))))}));
  const points=[...dense];
  // Fractional frame rates can put a knot between two samples. Preserve that corner, then remove only redundant
  // chords whose error against ALL original knots is <=0.2 dB (in addition to the <0.52 dB fade chord bound).
  while(points.length>64){
    let best=-1,bestError=.20000001;
    for(let i=1;i<points.length-1;i++){
      const a=points[i-1],b=points[i+1];let error=0;
      for(const point of dense)if(point.sample>a.sample&&point.sample<b.sample){
        const predicted=a.valueDb+(b.valueDb-a.valueDb)*(point.sample-a.sample)/(b.sample-a.sample);
        error=Math.max(error,Math.abs(predicted-point.valueDb));
      }
      if(error<bestError){best=i;bestError=error;}
    }
    if(best<0)break;points.splice(best,1);
  }
  if(points.length>64)throw Error("聲音曲線太複雜，請減少音量點後再播放或輸出。");
  return points;
}
