import { describe, expect, it } from "vitest";
import { uiFocusHoldJobFixtureV1 } from "./longformUiFocusHoldJobsV1.fixture";
import { sealLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { assembleLongformUiFocusProjectClockV1 } from "./longformUiFocusProjectClockV1";
async function fixture() {
  const f = await uiFocusHoldJobFixtureV1(), project = structuredClone(f.file.project), clip = project.tracks.flatMap(track => track.clips)[0];
  clip.id = f.draft.source.recordingId; clip.sourceStart = f.draft.source.start; clip.duration = f.draft.source.duration;
  const { artifactId:_artifact, ...original } = f.artifact;
  const artifact = sealLongformUiFocusArtifactV1({ ...original, request: { ...original.request, clipId:clip.id },
    project:{ id:project.id,revision:project.revision,canonicalSha256:colorDigest(project),clipId:clip.id,assetId:clip.assetId } });
  const actual = { frames:[0,2,2,3].map((i,index) => ({ projectFrame:8+index,sourcePts:f.result.frames[i].pts,
    sourceTime:f.result.frames[i].sourceTime,imageSha256:f.result.frames[i].imageSha256 })),
    sourceTimestampOffsetPts:0,inputFramesObserved:36,outputFramesObserved:Math.ceil(clip.duration*30),droppedSourceFrames:1,duplicatedSourceFrames:1,
    processStdoutSha256:"d".repeat(64),processStderrSha256:"e".repeat(64) };
  const provider = { decodeRuntimeIdentitySha256:"a".repeat(64),implementationSha256:"b".repeat(64) };
  const prepare = () => assembleLongformUiFocusProjectClockV1(project,artifact,f.result,actual,provider,{numerator:1,denominator:30});
  const resealHold = () => { const {receiptSha256:_r,...body}=f.result; f.result.receiptSha256=colorDigest(body); };
  return {...f,project,artifact,actual,provider,prepare,resealHold};
}
describe("owned hold to exact project-frame poses", () => {
  it("copies actual selected/drop/repeat poses and never claims native or default readiness",async()=>{
    const f=await fixture(), result=f.prepare();
    expect(result.frames.map(row=>row.sourceFrame)).toEqual([0,2,2,3]); expect(result.timelineStartFrame).toBe(8); expect(result.timelineEndFrame).toBe(12);
    expect(result.nativePresentationVerified).toBe(false); expect(result.browserPresentationVerified).toBe(false); expect(result.focusHintsReady).toBe(false);
    expect(result.selectableByDefault).toBe(false); expect(result.artworkStatus).toBe("ART_PENDING_CLAUDE");
    const {receiptSha256,...body}=result; expect(receiptSha256).toBe(colorDigest(body));
    result.frames[0].targetQuad[0].x=0; expect(f.result.frames[0].targetQuad[0].x).not.toBe(0);
  });
  it("refuses output fingerprint substitution or an unobserved source pose",async()=>{
    const f=await fixture(); f.actual.frames[0].imageSha256="f".repeat(64); expect(f.prepare).toThrow("PIXEL_OR_POSE_BINDING");
    const g=await fixture();g.actual.frames[0].sourcePts=9999;expect(g.prepare).toThrow("PIXEL_OR_POSE_BINDING");
  });
  it("refuses project frame gaps, out-of-clip frames and source reversal",async()=>{
    for (const change of [(f:Awaited<ReturnType<typeof fixture>>)=>{f.actual.frames[1].projectFrame+=1},
      (f:Awaited<ReturnType<typeof fixture>>)=>{f.actual.frames[0].projectFrame=9999},
      (f:Awaited<ReturnType<typeof fixture>>)=>{f.actual.frames[2]={...f.actual.frames[0],projectFrame:10}}]) {
      const f=await fixture();change(f);expect(f.prepare).toThrow("PIXEL_OR_POSE_BINDING");
    }
  });
  it("refuses resealed blocked or incomplete hold evidence",async()=>{
    const f=await fixture();f.result.state="BLOCKED";f.resealHold();expect(f.prepare).toThrow("HOLD_BINDING");
    const g=await fixture();g.result.sourceEnd+=.1;g.resealHold();expect(g.prepare).toThrow("HOLD_WINDOW");
  });
  it("requires current full project identity after revision, trim, move or fps edits",async()=>{
    for (const change of [(f:Awaited<ReturnType<typeof fixture>>)=>{f.project.revision++},
      (f:Awaited<ReturnType<typeof fixture>>)=>{f.project.tracks.flatMap(track=>track.clips)[0].sourceStart+=.1},
      (f:Awaited<ReturnType<typeof fixture>>)=>{f.project.tracks.flatMap(track=>track.clips)[0].timelineStart+=.1},
      (f:Awaited<ReturnType<typeof fixture>>)=>{f.project.fps=24}]) {
      const f=await fixture();change(f);expect(f.prepare).toThrow("CURRENT_CONTEXT");
    }
  });
  it("rejects provider timebase and clock budgets",async()=>{
    const f=await fixture();expect(()=>assembleLongformUiFocusProjectClockV1(f.project,f.artifact,f.result,f.actual,f.provider,{numerator:1,denominator:24})).toThrow("PROVIDER_BINDING");
    f.actual.outputFramesObserved=65536;expect(f.prepare).toThrow("PROVIDER_BINDING");
  });
});
