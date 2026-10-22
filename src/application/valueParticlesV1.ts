import * as z from "zod/v4";
import {applyCommand,type EditorCommand} from "../domain/commands";
import {dispatchCommandSafely} from "../domain/history";
import type {EditProject,ParticleSimulationSettings} from "../domain/types";
import {canonicalJson} from "../shared/canonicalJson";
import {buildGpuEngineVideoPreviewGraph} from "../render/gpuCompositor";
import {readMaterialIntelligence,readMaterialKeyframe,verifyMaterialSemanticsReceipt,materialTranscriptCueSha256,materialSemanticsInputSchema} from "./materialIntelligence";
import {verifyRotoKeyerSourceFile} from "./rotoKeyerAutopilot";
import type {ProjectSession,ProjectTask} from "./projectSession";

const sha=z.string().regex(/^[a-f0-9]{64}$/),v2=z.tuple([z.number().finite(),z.number().finite()]);
// Literal currency value only: no generated/inferred price or claim from a free-form purpose label.
const amount="(?:[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)(?:\\.\\d{1,2})?";
const quotedValue=z.string().max(100).regex(new RegExp(`^(?:(?:NT\\$|US\\$|\\$|€|¥)\\s?${amount}|${amount}\\s?(?:USD|TWD|NTD|EUR|JPY|元|圓|円|歐元))$`,"i"));
export const valueParticleRequestV1Schema=z.strictObject({
  expectedRevision:z.number().int().nonnegative(),id:z.string().regex(/^[a-z][a-z0-9-]{0,41}$/),clipId:z.string().min(1).max(160),
  range:z.strictObject({startFrame:z.number().int().nonnegative(),endFrame:z.number().int().positive()}),
  evidence:z.strictObject({materialId:sha,semanticReceiptSha256:sha,segmentIndex:z.number().int().min(0).max(255),cueIndex:z.number().int().min(0).max(1999),quotedValue}),
  parameters:z.strictObject({seed:z.number().int().min(0).max(0xffffffff),ratePerSecond:z.number().finite().positive().max(240),lifetimeSeconds:z.number().finite().positive().max(10),maxParticles:z.number().int().min(1).max(64),
    emitterPosition:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1)]),initialVelocity:v2,gravity:v2,radiusPixels:z.number().finite().positive().max(64),color:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)])}),
});
type Request=z.infer<typeof valueParticleRequestV1Schema>;
export interface ValueParticleRuntimeV1{cacheRoot:string;resolveSource:(assetId:string)=>Promise<string>}
interface Binding{assetId:string;sourcePath:string;sourceSha256:string;cueSha256:string;frameSha256:string[]}
export interface PreparedValueParticlesV1{schema:"editkin.value-particle-plan/v1";command:EditorCommand;nativeEmitterId:string;evidence:Binding;qualityState:"ART_PENDING_CLAUDE";defaultEnabled:false;currencyGlyphs:false;directApplyAllowed:false}
interface Owned{session:ProjectSession;task:ProjectTask;runtime:ValueParticleRuntimeV1;request:Request;fingerprint:string;command:EditorCommand;binding:Binding;busy:boolean;used:boolean}
const prepared=new WeakMap<PreparedValueParticlesV1,Owned>();
function clipFor(project:EditProject,request:Request){
  const tracks=project.tracks.filter(t=>t.clips.some(c=>c.id===request.clipId)),clips=tracks.flatMap(t=>t.clips.filter(c=>c.id===request.clipId));
  if(clips.length!==1||tracks[0].locked||tracks[0].hidden)throw Error("VALUE_PARTICLES_CLIP_MISSING_LOCKED_OR_HIDDEN");
  const clip=clips[0],asset=project.assets.find(a=>a.id===clip.assetId),start=request.range.startFrame/project.fps,end=request.range.endFrame/project.fps;
  if(!Number.isFinite(project.fps)||project.fps<1||project.fps>240||!asset||asset.kind!=="video"||asset.compositionId||clip.timeRemap||asset.clipRetime||(clip.speed??1)!==1
    ||end<=start||end>86400||start<clip.timelineStart-1e-8||end>clip.timelineStart+clip.duration+1e-8)throw Error("VALUE_PARTICLES_CLOCK_OR_SOURCE_UNSUPPORTED");
  return{clip,asset,start,end};
}
async function evidenceFor(project:EditProject,request:Request,runtime:ValueParticleRuntimeV1,current:()=>void):Promise<Binding>{
  const{clip,asset,start,end}=clipFor(project,request);current();
  const packet=await readMaterialIntelligence(runtime.cacheRoot,request.evidence.materialId);current();
  const semantic=await verifyMaterialSemanticsReceipt(runtime.cacheRoot,request.evidence.materialId,request.evidence.semanticReceiptSha256);current();
  if(packet.source.assetId!==asset.id||packet.source.clipId!==clip.id||packet.source.kind!=="video"||packet.source.sourceStart!==clip.sourceStart||packet.source.duration!==clip.duration
    ||semantic.materialId!==packet.materialId||semantic.sourceSha256!==packet.source.sourceSha256||packet.analysis.transcript.state!=="ready")throw Error("VALUE_PARTICLES_EVIDENCE_SOURCE_CHANGED");
  // A checksum is integrity, not a schema/authenticity guarantee. Re-admit the actual input shape.
  const admitted=materialSemanticsInputSchema.parse({materialId:semantic.materialId,sourceSha256:semantic.sourceSha256,overallTopic:semantic.overallTopic,contentType:semantic.contentType,language:semantic.language,people:semantic.people,locations:semantic.locations,segments:semantic.segments});
  const segment=admitted.segments[request.evidence.segmentIndex],cue=packet.analysis.transcript.cues[request.evidence.cueIndex],sealed=semantic.transcriptEvidence?.find(r=>r.cueIndex===request.evidence.cueIndex);
  if(!segment||segment.uncertainty||!segment.transcriptCueIndexes.includes(request.evidence.cueIndex)||!cue||!cue.text.includes(request.evidence.quotedValue)||!sealed
    ||segment.end<=segment.start||sealed.textSha256!==materialTranscriptCueSha256(cue)||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end>clip.duration||cue.end<=cue.start
    ||start<clip.timelineStart+Math.max(cue.start,segment.start)-1e-8||end>clip.timelineStart+Math.min(cue.end,segment.end)+1e-8)throw Error("VALUE_PARTICLES_VALUE_CUE_NOT_BOUND");
  const frameSha256:string[]=[];
  for(const id of segment.evidenceFrameIds){const frame=await readMaterialKeyframe(runtime.cacheRoot,packet.materialId,id);current();frameSha256.push(frame.frame.sha256);}
  const sourcePath=await runtime.resolveSource(asset.id);current();await verifyRotoKeyerSourceFile(sourcePath,packet.source.sourceSha256);current();
  return{assetId:asset.id,sourcePath,sourceSha256:packet.source.sourceSha256,cueSha256:sealed.textSha256,frameSha256};
}
export async function prepareValueParticlesV1(session:ProjectSession,runtime:ValueParticleRuntimeV1,payload:unknown,signal?:AbortSignal):Promise<PreparedValueParticlesV1>{
  const request=valueParticleRequestV1Schema.parse(payload),project=session.getSnapshot().history.present,task=session.beginTask(project),current=()=>{signal?.throwIfAborted();if(!task.isCurrent())throw Error("VALUE_PARTICLES_PROJECT_CHANGED");};
  current();if(project.revision!==request.expectedRevision)throw Error("VALUE_PARTICLES_REVISION_CHANGED");const{start,end}=clipFor(project,request);
  const binding=await evidenceFor(project,request,runtime,current),existing=project.particleSimulation,id=`value-${request.id}`,parameters={...request.parameters,timeline:{start,duration:end-start}};
  let settings:ParticleSimulationSettings;const commands:EditorCommand[]=[];
  if(existing){
    if(!existing.enabled||(existing.additionalEmitters??[]).some(e=>e.id===id))throw Error("VALUE_PARTICLES_EMITTER_DISABLED_OR_DUPLICATE");
    settings={...structuredClone(existing),additionalEmitters:[...(structuredClone(existing.additionalEmitters)??[]),{id,...parameters}]};
  }else{commands.push({type:"configure_particle_simulation",enabled:true});settings={schema:"editkin.particle-simulation/v1",enabled:true,...parameters};}
  commands.push({type:"set_particle_simulation_settings",settings});const command:EditorCommand={type:"batch",commands},applied=applyCommand(project,command);
  if(!buildGpuEngineVideoPreviewGraph(applied,start))throw Error("VALUE_PARTICLES_NATIVE_VIDEO_ROUTE_UNAVAILABLE");current();
  const packet:PreparedValueParticlesV1={schema:"editkin.value-particle-plan/v1",command,nativeEmitterId:existing?id:"primary",evidence:binding,qualityState:"ART_PENDING_CLAUDE",defaultEnabled:false,currencyGlyphs:false,directApplyAllowed:false};
  prepared.set(packet,{session,task,runtime,request,fingerprint:canonicalJson(packet),command:structuredClone(command),binding:structuredClone(binding),busy:false,used:false});return packet;
}
export async function applyPreparedValueParticlesV1(session:ProjectSession,packet:PreparedValueParticlesV1,signal?:AbortSignal){
  const owned=prepared.get(packet);if(!owned||owned.session!==session||owned.used||owned.busy||owned.fingerprint!==canonicalJson(packet))throw Error("VALUE_PARTICLES_PREPARED_PACKET_INVALID");owned.busy=true;
  const current=()=>{signal?.throwIfAborted();if(!owned.task.isCurrent()||owned.fingerprint!==canonicalJson(packet))throw Error("VALUE_PARTICLES_PROJECT_OR_PACKET_CHANGED");};
  try{
    current();const binding=await evidenceFor(session.getSnapshot().history.present,owned.request,owned.runtime,current);if(canonicalJson(binding)!==canonicalJson(owned.binding))throw Error("VALUE_PARTICLES_SOURCE_CHANGED");current();
    const result=dispatchCommandSafely(session.getSnapshot().history,structuredClone(owned.command));if(result.error)throw Error(result.error);
    owned.used=true;session.setHistory(result.state);return{undoSteps:1,qualityState:"ART_PENDING_CLAUDE" as const,defaultEnabled:false as const,nativeEmitterId:packet.nativeEmitterId};
  }finally{owned.busy=false;}
}
