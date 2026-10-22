import { uiFocusHoldJobFixtureV1 } from "./longformUiFocusHoldJobsV1.fixture";
import { sealLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { assembleLongformUiFocusProjectClockV1 } from "./longformUiFocusProjectClockV1";
/** Synthetic protocol input; actual native frame pixels are tested separately. */
export async function uiFocusNativeFrameFixtureV1(){
  const f=await uiFocusHoldJobFixtureV1(),project=structuredClone(f.file.project),clip=project.tracks.flatMap(track=>track.clips)[0];
  clip.id=f.draft.source.recordingId;clip.sourceStart=f.draft.source.start;clip.duration=f.draft.source.duration;clip.timelineStart=.2;
  const {artifactId:_id,...body}=f.artifact;
  const artifact=sealLongformUiFocusArtifactV1({...body,request:{...body.request,clipId:clip.id},project:{id:project.id,revision:project.revision,
    canonicalSha256:colorDigest(project),clipId:clip.id,assetId:clip.assetId}});
  const actual={frames:f.result.frames.map((row,i)=>({projectFrame:8+i,sourcePts:row.pts,sourceTime:row.sourceTime,imageSha256:row.imageSha256})),
    sourceTimestampOffsetPts:0,inputFramesObserved:36,outputFramesObserved:Math.ceil(clip.duration*30),droppedSourceFrames:0,duplicatedSourceFrames:0,
    processStdoutSha256:'d'.repeat(64),processStderrSha256:'e'.repeat(64)};
  const clock=assembleLongformUiFocusProjectClockV1(project,artifact,f.result,actual,{decodeRuntimeIdentitySha256:f.result.provider.decodeRuntimeIdentitySha256,
    implementationSha256:'a'.repeat(64)},{numerator:1,denominator:30});
  return{...f,project,artifact,clock};
}
