import {copyFile,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createEmptyProject,findAsset} from "../domain/editGraph";
import {DEFAULT_COLOR,DEFAULT_TRANSFORM} from "../domain/types";
import {prepareMaterialIntelligence,recordMaterialSemantics} from "../application/materialIntelligence";
import {colorFileSha,runColorProcess} from "../application/materialColorSamplingRuntime";
import type {ShotGradeRegionV1} from "../color/shotGradeStatisticsV1";
import {REPO_TMP,useTempRoots} from "./tempRoot.mjs";
const app=fileURLToPath(new URL("../../",import.meta.url));
export const shotGradeTestToolsV1={ffmpegPath:join(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobePath:join(app,"vendor/ffmpeg/win32-x64/ffprobe.exe")};
export async function createShotGradeFixtureV1(temp:ReturnType<typeof useTempRoots>,width=32,height=16,checkerboard=false){
 const root=await temp.create("shot-grade-owned-",{parent:REPO_TMP}),source=join(root,"source.mp4"),referenceSource=join(root,"reference.mp4"),raw=join(root,"authored.rgba");
 const pixels=new Uint8Array(width*height*4*8);
 for(let f=0;f<8;f++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const rgb=checkerboard?(x%2?[230,20,70]:[20,220,140]):x<width/2?[100+f,100+f,100+f]:[147+f,110+f,87+f];
  pixels.set([...rgb,255],((f*height+y)*width+x)*4);
 }
 await writeFile(raw,pixels);
 await runColorProcess(shotGradeTestToolsV1.ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-threads","1","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",width+"x"+height,"-framerate","10","-i",raw,
  "-vf","format=yuv444p,setsar=1","-an","-c:v","libx264","-preset","ultrafast","-qp","0","-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",source],4096);
 await copyFile(source,referenceSource);
 const project=createEmptyProject("Owned numeric grade fixture",{width,height,fps:10});
 project.assets=[{id:"target-asset",name:"Technical neutral/warm strips",kind:"video",uri:source,duration:.8,width,height,displayAspectRatio:width/height,color:{interpretation:"rec709"}},
  {id:"reference-asset",name:"Separate owned reference bytes",kind:"video",uri:referenceSource,duration:.8,width,height,displayAspectRatio:width/height,color:{interpretation:"rec709"}}];
 project.tracks[0].clips=["target","reference"].map((id,index)=>({id,assetId:id+"-asset",trackId:project.tracks[0].id,timelineStart:index*.7,sourceStart:0,duration:.6,volume:0,
  transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],...(index?{gradeV2:{schema:"editkin.color-grade/v2" as const,nodes:[{id:"declared-reference-gain",gain:{master:.12}}]}}:{})}));
 const runtime={...shotGradeTestToolsV1,cacheRoot:root,modelRoot:root,resolveSource:async(assetId:string)=>findAsset(project,assetId).uri};
 const prepare=async(clipId:string)=>{
  const clip=project.tracks[0].clips.find(c=>c.id===clipId)!,asset=findAsset(project,clip.assetId),sourceSha256=await colorFileSha(asset.uri);
  const {packet}=await prepareMaterialIntelligence({clipId,assetId:asset.id,sourcePath:asset.uri,sourceSha256,sourceStart:0,duration:.6,fps:10,kind:"video",color:asset.color,
   colorManagement:project.colorManagement,includeTranscript:false,maxKeyframes:2},runtime);
  if(packet.analysis.color?.status!=="measured")throw Error("Owned fixture material colour not measured");
  const semantics=await recordMaterialSemantics(root,{materialId:packet.materialId,sourceSha256,overallTopic:"Authored technical numeric fixture",contentType:"fixture",language:"en",people:[],locations:[],
   segments:[{start:0,end:.6,summary:"Synthetic grey and warm swatches used as caller-declared numeric ROIs; no person, white classification or art certification",subjects:[],actions:[],objects:[],importance:.5,evidenceFrameIds:[packet.keyframes[0].id],transcriptCueIndexes:[]}]});
  const regions:ShotGradeRegionV1[]=packet.analysis.color.mapping.flatMap(row=>[
   {sampleId:row.id,role:"neutral" as const,x:0,y:0,width:.5,height:1},{sampleId:row.id,role:"skin" as const,x:.5,y:0,width:.5,height:1}]);
  return {packet,binding:{materialId:packet.materialId,semanticReceiptSha256:semantics.semanticReceiptSha256},regions};
 };
 const target=await prepare("target"),reference=await prepare("reference"),projectPath=join(root,"fixture.editkin.json");await writeFile(projectPath,JSON.stringify(project));
 return {root,source,referenceSource,project,projectPath,runtime,target,reference,
  request:{target:target.binding,reference:reference.binding,regions:target.regions,referenceRegions:reference.regions,roiBasis:"local-layer-raster-normalized" as const,reason:"Explicit owned neutral/skin numeric reference, not scene inference",maximumTimeMs:40000},
  originalSource:await readFile(source),originalReferenceSource:await readFile(referenceSource)};
}
