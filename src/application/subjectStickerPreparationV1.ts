import type{ProjectSession}from'./projectSession';import{compileClipAlphaPlan,pixelMatteOperation,clipLocalProjectFrame,floorClipAlphaSampleIndex}from'../domain/clipAlphaPlan';
import{verifyFrozenRotoMatte}from'../render/autoRotoMatteIntegrity';import{subjectStickerStyleV1Schema,type SubjectStickerStyleV1}from'../render/subjectStickerV1';
import{verifyRotoKeyerSourceFile}from'./rotoKeyerAutopilot';
/** Identity verification does not promote diagnostic roto pixels into trusted real-footage quality. */
export async function prepareSubjectStickerV1(session:ProjectSession,input:{clipId:string;style:SubjectStickerStyleV1;productCacheRoot:string;sourceSha256:string;resolveSource:(assetId:string)=>Promise<string>},signal?:AbortSignal){
  const project=session.getSnapshot().history.present,task=session.beginTask(project),current=()=>{signal?.throwIfAborted();if(!task.isCurrent())throw Error('STICKER_PROJECT_CHANGED');},style=subjectStickerStyleV1Schema.parse(input.style);current();
  const tracks=project.tracks.filter(t=>t.clips.some(c=>c.id===input.clipId)),clips=tracks.flatMap(t=>t.clips.filter(c=>c.id===input.clipId));
  if(clips.length!==1||tracks[0].locked)throw Error('STICKER_CLIP_MISSING_OR_LOCKED');const clip=clips[0],asset=project.assets.find(a=>a.id===clip.assetId);
  if(!asset||asset.kind!=='video'||asset.compositionId||asset.clipRetime||clip.timeRemap||(clip.speed??1)!==1)throw Error('STICKER_SOURCE_CLOCK_UNSUPPORTED');
  const alphaPlan=compileClipAlphaPlan(project,clip,'formal'),matte=pixelMatteOperation(alphaPlan);
  if(!matte)throw Error('STICKER_FROZEN_ROTO_MATTE_REQUIRED');
  const sourcePath=await input.resolveSource(asset.id);current();await verifyRotoKeyerSourceFile(sourcePath,input.sourceSha256);current();
  const sequence=matte.matte.sequence;
  if(sequence.frameCount!==Math.ceil(clip.duration*sequence.analysisFps))throw Error('STICKER_MATTE_SOURCE_CLOCK_MISMATCH');
  await verifyFrozenRotoMatte(sequence,sequence.sequenceUri,sequence.manifestUri!,input.productCacheRoot);current();
  const first=clipLocalProjectFrame(alphaPlan,0),last=clipLocalProjectFrame(alphaPlan,Math.max(0,clip.duration-1/project.fps));
  if(floorClipAlphaSampleIndex(alphaPlan,first)===undefined||floorClipAlphaSampleIndex(alphaPlan,last)===undefined)throw Error('STICKER_MATTE_RANGE_NOT_COVERED');
  return{schema:'editkin.subject-sticker-preparation/v1' as const,clipId:clip.id,projectId:project.id,projectRevision:project.revision,sourcePath,sourceSha256:input.sourceSha256,
    alphaPlan:structuredClone(alphaPlan),style,sourceStart:clip.sourceStart,duration:clip.duration,fps:project.fps,width:project.width,height:project.height,
    inputContract:'existing mask pipeline supplies same-size/project-rate effective alpha, source alpha multiplied exactly once' as const,
    matteIdentity:'VERIFIED_PRODUCT_ARTIFACT' as const,matteQuality:sequence.qualityState,qualityState:'ART_PENDING_CLAUDE' as const,defaultEnabled:false as const,directApplyAllowed:false as const};
}
