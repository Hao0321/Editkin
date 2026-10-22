import * as z from "zod/v4";
import { EditGraphError } from "./editGraphError";
import type { TimelineClip } from "./types";

export const AUDIO_ENVELOPE_SCHEMA = "editkin.clip-audio-envelope/v1" as const;
export const MAX_CLIP_VOLUME_POINTS = 16;
export interface ClipVolumePoint { id: string; time: number; db: number }
/** Separate clocks let a fade be edited after a trim without moving existing volume points. */
export interface ClipAudioEnvelope {
  schema: typeof AUDIO_ENVELOPE_SCHEMA;
  fades?: { in: number; out: number; duration: number; offset: number };
  volume?: { points: ClipVolumePoint[]; offset: number };
}
const seconds = z.number().finite().min(-86400).max(86400);
export const clipAudioEnvelopeSchema = z.strictObject({
  schema: z.literal(AUDIO_ENVELOPE_SCHEMA),
  fades: z.strictObject({ in: z.number().finite().min(0).max(5), out: z.number().finite().min(0).max(5),
    duration: z.number().finite().positive().max(86400), offset: seconds }).refine(f => f.in+f.out <= f.duration+1e-8,
    "淡入和淡出的總長度不能超過片段。" ).optional(),
  volume: z.strictObject({ points: z.array(z.strictObject({ id: z.string().min(1).max(160), time: seconds,
    db: z.number().finite().min(-30).max(6) })).min(1).max(MAX_CLIP_VOLUME_POINTS), offset: seconds })
    .refine(v => new Set(v.points.map(p=>p.id)).size===v.points.length && v.points.every((p,i)=>i===0||p.time>v.points[i-1].time),
      "音量點必須有不同的名稱，並依時間排列。" ).optional(),
}).refine(e=>e.fades!==undefined||e.volume!==undefined,"請設定淡化或音量點。");

export function assertClipAudioEnvelope(envelope: ClipAudioEnvelope | undefined): void {
  if(envelope===undefined)return;
  const parsed=clipAudioEnvelopeSchema.safeParse(envelope);
  if(!parsed.success)throw new EditGraphError("聲音淡化或音量點不合法；淡化為 0–5 秒、音量點為 -30 至 +6 dB，最多 16 點。");
}
export function clipVolumePointDbAt(clip: Pick<TimelineClip,"audioEnvelope">,localSeconds: number): number {
  const volume=clip.audioEnvelope?.volume;if(!volume)return 0;
  const time=localSeconds+volume.offset,points=volume.points;
  if(time<=points[0].time)return points[0].db;
  const next=points.findIndex(p=>p.time>time);
  if(next<0)return points.at(-1)!.db;
  const a=points[next-1],b=points[next];return a.db+(b.db-a.db)*(time-a.time)/(b.time-a.time);
}
export function effectiveClipFades(clip: Pick<TimelineClip,"duration"|"audioEnvelope">,music=false) {
  return clip.audioEnvelope?.fades ?? {in:music?Math.min(1.2,clip.duration/5):0,out:music?Math.min(1.2,clip.duration/5):0,duration:clip.duration,offset:0};
}
export function clipAudioGainAt(clip: Pick<TimelineClip,"volume"|"duration"|"audioEnvelope">,localSeconds:number,music=false):number {
  const fade=effectiveClipFades(clip,music),time=localSeconds+fade.offset;
  const incoming=fade.in>0?Math.max(0,Math.min(1,time/fade.in)):1;
  const outgoing=fade.out>0?Math.max(0,Math.min(1,(fade.duration-time)/fade.out)):1;
  return clip.volume*10**(clipVolumePointDbAt(clip,localSeconds)/20)*incoming*outgoing;
}
/** Intersection of the original fade range with the currently visible source window. */
export function visibleClipFadeSeconds(clip: Pick<TimelineClip,"duration"|"audioEnvelope">,music=false) {
  const f=effectiveClipFades(clip,music),start=f.offset,end=start+clip.duration;
  return {in:Math.max(0,Math.min(end,f.in)-Math.max(0,start)),out:Math.max(0,Math.min(end,f.duration)-Math.max(start,f.duration-f.out))};
}
export function shiftedClipAudioEnvelope(clip: Pick<TimelineClip,"audioEnvelope">,seconds:number):ClipAudioEnvelope|undefined {
  if(!clip.audioEnvelope)return undefined;
  const envelope=structuredClone(clip.audioEnvelope);
  if(envelope.fades)envelope.fades.offset+=seconds;
  if(envelope.volume)envelope.volume.offset+=seconds;
  assertClipAudioEnvelope(envelope);return envelope;
}
export function withClipAudioFades(clip: Pick<TimelineClip,"duration"|"audioEnvelope">,incoming:number,outgoing:number):ClipAudioEnvelope {
  const envelope:ClipAudioEnvelope={...structuredClone(clip.audioEnvelope??{schema:AUDIO_ENVELOPE_SCHEMA}),fades:{in:incoming,out:outgoing,duration:clip.duration,offset:0}};
  assertClipAudioEnvelope(envelope);return envelope;
}
export function withClipVolumePoint(clip:Pick<TimelineClip,"audioEnvelope">,point:ClipVolumePoint):ClipAudioEnvelope {
  const envelope:ClipAudioEnvelope=structuredClone(clip.audioEnvelope??{schema:AUDIO_ENVELOPE_SCHEMA});
  const volume=envelope.volume??{points:[],offset:0};
  const existing=volume.points.find(p=>Math.abs(p.time-(point.time+volume.offset))<1e-8);
  volume.points=volume.points.filter(p=>p.id!==point.id&&p.id!==existing?.id);
  volume.points.push({...point,id:existing?.id??point.id,time:point.time+volume.offset});
  volume.points.sort((a,b)=>a.time-b.time);envelope.volume=volume;assertClipAudioEnvelope(envelope);return envelope;
}
export function withoutClipVolumePoint(clip:Pick<TimelineClip,"audioEnvelope">,id:string):ClipAudioEnvelope|undefined {
  if(!clip.audioEnvelope?.volume?.points.some(p=>p.id===id))throw new EditGraphError("找不到這個音量點，請重新選取。");
  const envelope=structuredClone(clip.audioEnvelope);envelope.volume!.points=envelope.volume!.points.filter(p=>p.id!==id);
  if(!envelope.volume!.points.length)delete envelope.volume;
  return envelope.fades||envelope.volume?envelope:undefined;
}
/** Speed presets keep authored fade seconds; content-bound volume points follow the new duration. */
export function retimedClipAudioEnvelope(clip:Pick<TimelineClip,"duration"|"audioEnvelope">,duration:number):ClipAudioEnvelope|undefined {
  if(!clip.audioEnvelope)return undefined;
  const result=structuredClone(clip.audioEnvelope),ratio=duration/clip.duration;
  if(result.fades){
    const visible=visibleClipFadeSeconds(clip),sum=visible.in+visible.out,limit=sum>duration?duration/sum:1;
    result.fades={in:visible.in*limit,out:visible.out*limit,duration,offset:0};
  }
  if(result.volume){result.volume.offset*=ratio;result.volume.points=result.volume.points.map(p=>({...p,time:p.time*ratio}));}
  assertClipAudioEnvelope(result);return result;
}
