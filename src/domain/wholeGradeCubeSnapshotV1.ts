import {findAsset,findClip,findTrack,animatedClipState} from './editGraph';
import {DEFAULT_COLOR_MANAGEMENT,type EditProject} from './types';
import {assertClipGradeSnapshotV1} from './clipGradeSnapshotV1';
/** Copy only this clip's colour recipe. Export does not mutate project/history or transfer its animation. */
export function captureWholeGradeCubeV1(project:EditProject,clipId:string,playhead:number){
  if(!Number.isFinite(playhead)||!Number.isFinite(project.fps)||project.fps<=0||project.fps>240)throw Error('整套調色 LUT 取樣時間不合法。');
  const clip=findClip(project,clipId),asset=findAsset(project,clip.assetId),track=findTrack(project,clip.trackId);
  if(track.kind!=='video'||!['video','image'].includes(asset.kind)||(clip.layer?.role??'content')!=='content'||asset.imageSequence||asset.compositionId||asset.clipRetime)throw Error('此片段需要另外的整套調色 LUT 轉換器。');
  const localTime=Math.max(0,Math.min(clip.duration,playhead-clip.timelineStart));
  const snapshot=assertClipGradeSnapshotV1({schema:'editkin.clip-grade-snapshot/v1',color:animatedClipState(clip,localTime,project.fps).color,...(clip.gradeV2?{gradeV2:clip.gradeV2}:{})});
  return{schema:'editkin.whole-grade-cube-snapshot/v1' as const,clipId,assetId:asset.id,sourceName:asset.name,localTime,fps:project.fps,
    color:structuredClone(snapshot.color),gradeV2:snapshot.gradeV2?structuredClone(snapshot.gradeV2):undefined,
    legacyLookId:clip.creative?.lookPresetId,management:structuredClone(project.colorManagement??DEFAULT_COLOR_MANAGEMENT),rec709Input:clip.rec709Input,
    asset:{...asset,color:asset.color?{...asset.color}:undefined},
    excluded:{spatialFinishing:true as const,geometryAndAlpha:true as const,otherLayers:true as const,animationBeyondSample:true as const,effectPresetIds:[...(clip.creative?.effectPresetIds??[])]}};
}
export type WholeGradeCubeSnapshotV1=ReturnType<typeof captureWholeGradeCubeV1>;
