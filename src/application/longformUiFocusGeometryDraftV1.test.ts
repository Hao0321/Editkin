import {describe,it,expect} from "vitest";
import {uiFocusNativeFrameFixtureV1} from "./longformUiFocusNativeFrameV1.fixture";
import {prepareLongformUiFocusGeometryDraftV1,describeLongformUiFocusGeometryV1} from "./longformUiFocusGeometryDraftV1";
import type {LongformUiFocusGeometryProcessResultV1} from "./longformUiFocusGeometryProcessV1";
import {colorDigest} from "./materialColorSamplingRuntime";
import {verifyLongformUiFocusGeometryFrameHashV1} from "./longformUiFocusGeometryRuntimeV1";
async function fixture(){const f=await uiFocusNativeFrameFixtureV1(),{project,clock}=f;
  const actual:LongformUiFocusGeometryProcessResultV1={...clock.provider,sourceTimestampOffsetPts:clock.sourceTimestampOffsetPts,
    geometryFramesObserved:clock.provider.outputFramesObserved,stdoutBytes:0,stderrBytes:0,
    frames:clock.frames.map((row,i)=>({...row,frame:i,checksum:'12345678'})),
    geometry:clock.frames.map(row=>({schema:'editkin.longform-ui-focus-geometry-witness/v1',projectFrame:row.projectFrame,geometryPts:row.projectFrame-6,
      timeBase:{numerator:1,denominator:30},fit:{width:project.width,height:project.height},layout:{width:project.width,height:project.height},
      affine:{mode:'scale-rotate',input:{width:project.width,height:project.height},scaled:{width:project.width,height:project.height},output:{width:project.width,height:project.height}},placement:{x:0,y:0}}))};
  return{...f,actual};}
describe('private actual source hold geometry draft',()=>{
  it('binds actual source winners/PTS/full pixel stream to projected frames and returns clone-only metadata',async()=>{
    const f=await fixture(),before=structuredClone(f.project),handle=prepareLongformUiFocusGeometryDraftV1(f.project,f.artifact,f.result,f.clock,f.actual,'f'.repeat(64),'b'.repeat(64));
    const draft=describeLongformUiFocusGeometryV1(f.project,handle);expect(draft.frames).toHaveLength(24);expect(draft.actualSourceHoldGeometryIntegrated).toBe(true);
    expect(draft.nativePresentationVerified).toBe(false);draft.frames[0].sourceQuad[0].x=.9;
    expect(describeLongformUiFocusGeometryV1(f.project,handle).frames[0].sourceQuad[0].x).not.toBe(.9);expect(f.project).toEqual(before);
    expect(()=>describeLongformUiFocusGeometryV1(f.project,{...handle})).toThrow('FACTORY');
    f.project.name+='changed';expect(()=>describeLongformUiFocusGeometryV1(f.project,handle)).toThrow('CURRENT_PROJECT');
  });
  it('rejects caller-resealed clocks, changed source pixel streams and per-frame winner/geometry mismatches',async()=>{
    const f=await fixture(),prepare=()=>prepareLongformUiFocusGeometryDraftV1(f.project,f.artifact,f.result,f.clock,f.actual,'f'.repeat(64),'b'.repeat(64));
    f.actual.processStdoutSha256='0'.repeat(64);expect(prepare).toThrow('ACTUAL_SOURCE_CLOCK');f.actual.processStdoutSha256=f.clock.provider.processStdoutSha256;
    f.actual.frames[0].sourcePts++;expect(prepare).toThrow('ACTUAL_FRAME_BINDING');f.actual.frames[0].sourcePts--;
    f.actual.geometry[0].projectFrame++;expect(prepare).toThrow('ACTUAL_FRAME_BINDING');f.actual.geometry[0].projectFrame--;
    f.clock.frames[0].targetQuad[0].x+=.01;const{receiptSha256:_seal,...body}=f.clock;f.clock.receiptSha256=colorDigest(body);expect(prepare).toThrow('CLOCK_BINDING');
  });
  it('requires actual contiguous project framehash output with the measured project timebase',()=>{
    const header='#tb 0: 1/30\n',line='0, 6, 6, 1, 921600, '+'a'.repeat(64)+'\n',bytes=Buffer.from(header+line);
    expect(verifyLongformUiFocusGeometryFrameHashV1(bytes,6,1,{numerator:1,denominator:30},640,360).frames).toBe(1);
    expect(()=>verifyLongformUiFocusGeometryFrameHashV1(Buffer.from((header+line).replace(' 6, 6,',' 7, 7,')),6,1,{numerator:1,denominator:30},640,360)).toThrow('FRAMEHASH_FRAME');
    expect(()=>verifyLongformUiFocusGeometryFrameHashV1(bytes,6,2,{numerator:1,denominator:30},640,360)).toThrow('COVERAGE');
    expect(()=>verifyLongformUiFocusGeometryFrameHashV1(bytes,6,1,{numerator:1,denominator:24},640,360)).toThrow('TIME_BASE');
  });
});
