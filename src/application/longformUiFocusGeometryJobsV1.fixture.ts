import {uiFocusNativeFrameFixtureV1} from "./longformUiFocusNativeFrameV1.fixture";
import {prepareLongformUiFocusGeometryDraftV1} from "./longformUiFocusGeometryDraftV1";
import type {LongformUiFocusGeometryProcessResultV1} from "./longformUiFocusGeometryProcessV1";
/** Synthetic protocol input only. Actual source/geometry pixels have a separate
 * owned physical runtime/transport receipt and are not inferred from this. */
export async function uiFocusGeometryJobFixtureV1(){
  const f=await uiFocusNativeFrameFixtureV1(),{project,clock}=f;
  const actual:LongformUiFocusGeometryProcessResultV1={...clock.provider,sourceTimestampOffsetPts:clock.sourceTimestampOffsetPts,
    geometryFramesObserved:clock.provider.outputFramesObserved,stdoutBytes:0,stderrBytes:0,
    frames:clock.frames.map((row,i)=>({...row,frame:i,checksum:'12345678'})),
    geometry:clock.frames.map(row=>({schema:'editkin.longform-ui-focus-geometry-witness/v1',projectFrame:row.projectFrame,geometryPts:row.projectFrame-6,
      timeBase:{numerator:1,denominator:30},fit:{width:project.width,height:project.height},layout:{width:project.width,height:project.height},
      affine:{mode:'scale-rotate',input:{width:project.width,height:project.height},scaled:{width:project.width,height:project.height},output:{width:project.width,height:project.height}},placement:{x:0,y:0}}))};
  const handle=prepareLongformUiFocusGeometryDraftV1(project,f.artifact,f.result,clock,actual,'f'.repeat(64),'b'.repeat(64));
  return{...f,request:{...f.request,artifactId:f.artifact.artifactId},value:{project,handle}};
}
