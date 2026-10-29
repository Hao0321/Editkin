import {describe,expect,it} from 'vitest';
import {uiFocusNativeFrameFixtureV1} from './longformUiFocusNativeFrameV1.fixture';
import {prepareLongformUiFocusNativeFramesV1 as prepare,describeLongformUiFocusNativeFramesV1 as describeFrames,longformUiFocusNativeFrameV1 as frame} from './longformUiFocusNativeFrameV1';
import {colorDigest} from './materialColorSamplingRuntime';
describe('owned source-display focus frame factory',()=>{
  it('uses every exact clock/hold pose and the approved fade, without project-readiness claims',async()=>{
    const f=await uiFocusNativeFrameFixtureV1(),handle=prepare(f.project,f.artifact,f.result,f.clock),draft=describeFrames(f.project,handle);
    expect(draft.frames).toHaveLength(24);expect(draft.frames.map(row=>row.sourcePts)).toEqual(f.clock.frames.map(row=>row.sourcePts));
    expect(draft.frames.map(row=>row.targetQuad)).toEqual(f.clock.frames.map(row=>row.targetQuad));expect(draft.frames[0].opacity).toBe(0);
    expect(draft.frames[6].opacity).toBe(1);expect(draft.frames[20].opacity).toBe(1);expect(draft.frames[23].opacity).toBe(0);
    expect(draft.canvas.coordinateSpace).toBe('upright-source-display');expect(draft.editableProjectGraphCompiled).toBe(false);expect(draft.projectGeometryProjected).toBe(false);
    expect(draft.focusHintsReady).toBe(false);expect(draft.selectableByDefault).toBe(false);expect(draft.artworkStatus).toBe('ART_PENDING_CLAUDE');
    expect(frame(f.project,handle,8).scene.layers).toHaveLength(1);
  });
  it('returns empty overlays before and at the half-open end, never extending or reacquiring',async()=>{
    const f=await uiFocusNativeFrameFixtureV1(),handle=prepare(f.project,f.artifact,f.result,f.clock);
    expect(frame(f.project,handle,7).scene.layers).toHaveLength(0);expect(frame(f.project,handle,32).scene.layers).toHaveLength(0);
    expect(frame(f.project,handle,33).poses).toHaveLength(0);expect(()=>frame(f.project,handle,8.1)).toThrow('INTEGER_FRAME');
  });
  it('does not accept cloned handles, stale projects or mutate caller/returned coordinates',async()=>{
    const f=await uiFocusNativeFrameFixtureV1(),before=colorDigest(f),handle=prepare(f.project,f.artifact,f.result,f.clock);
    expect(colorDigest(f)).toBe(before);expect(()=>describeFrames(f.project,structuredClone(handle))).toThrow('FACTORY');
    const draft=describeFrames(f.project,handle);draft.frames[0].targetQuad[0].x=0;expect(describeFrames(f.project,handle).frames[0].targetQuad[0].x).not.toBe(0);
    f.project.revision++;expect(()=>frame(f.project,handle,8)).toThrow('CURRENT_PROJECT');
  });
  it('rejects a resealed substituted pose or clock identity and incomplete hint span',async()=>{
    const seal=(value:Awaited<ReturnType<typeof uiFocusNativeFrameFixtureV1>>['clock'])=>{const{receiptSha256:_id,...body}=value;value.receiptSha256=colorDigest(body);};
    const f=await uiFocusNativeFrameFixtureV1();f.clock.frames[1].targetQuad[0].x+=.01;seal(f.clock);expect(()=>prepare(f.project,f.artifact,f.result,f.clock)).toThrow('CLOCK_BINDING');
    const g=await uiFocusNativeFrameFixtureV1();g.clock.artifactId='a'.repeat(64);seal(g.clock);expect(()=>prepare(g.project,g.artifact,g.result,g.clock)).toThrow('CLOCK_BINDING');
    const h=await uiFocusNativeFrameFixtureV1();h.clock.frames=h.clock.frames.slice(0,10);h.clock.timelineEndFrame=18;seal(h.clock);
    expect(()=>prepare(h.project,h.artifact,h.result,h.clock)).toThrow('HINT_WINDOW');
  });
});
