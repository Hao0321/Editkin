import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { applyCommand } from "../src/domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipKeyframe, type FloatingVideoFrame, type Transform2D } from "../src/domain/types";
import { createMotionGraphic } from "../src/motion/composition";
import { findMotionGraphicPreset } from "../src/creative/motionGraphicPresets";
import { motionGraphicV2LayoutReceipt } from "../src/motion/compositionV2";
import { renderProject } from "../src/render/ffmpeg";
const root=resolve(import.meta.dirname,".."),evidence=join(root,".rd/benchmarks/motion-art-redesign-20260930");
const duration=5;
const run=promisify(execFile),sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const ffmpeg=join(root,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobe=join(root,"vendor/ffmpeg/win32-x64/ffprobe.exe");
const receipts=JSON.parse(await readFile(join(root,".rd/benchmarks/motion-reference-templates-20260930/owned-source-receipts.json"),"utf8"));
let project=createEmptyProject("讓作品成為主角 · 美術診斷",{id:"art-redesign-gallery",width:540,height:960,fps:30});
const sources=[];
for(let i=0;i<3;i++){
  const source=receipts[i],bytes=await readFile(source.normalizedPath);
  if(sha(bytes)!==source.normalizedSha256||source.normalizedProbe.duration<duration)throw new Error("Owned source receipt stale or too short");
  project.assets.push({id:`owned-${i}`,name:`自有陶藝 ${i+1}`,kind:"video",uri:source.normalizedPath,duration:source.normalizedProbe.duration,width:source.normalizedProbe.width,height:source.normalizedProbe.height,color:{interpretation:"rec709"},provenance:`Owned original ${source.originalPath}; SHA ${source.normalizedSha256}`});
  sources.push({originalPath:source.originalPath,originalSha256:source.originalSha256,normalizedSha256:source.normalizedSha256,readOnly:true});
}
const background=join(evidence,"original-blue-white-grid.png");
project.assets.push({id:"original-grid",name:"原創藍白細網格",kind:"image",uri:background,duration,width:540,height:960,provenance:"Original programmed gradient/grid; no reference assets"});
project.tracks[0].clips.push({id:"backdrop",trackId:project.tracks[0].id,assetId:"original-grid",sourceStart:0,timelineStart:0,duration,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]});
const frames:Array<{id:string;asset:number;frame:FloatingVideoFrame}>=[
  {id:"rear-left",asset:0,frame:{schema:"editkin.floating-video-frame/v1",style:"matte",aspect:"portrait",size:.45,yawDegrees:-14,pitchDegrees:1,centerX:.28,centerY:.50}},
  {id:"rear-right",asset:2,frame:{schema:"editkin.floating-video-frame/v1",style:"matte",aspect:"portrait",size:.43,yawDegrees:12,pitchDegrees:1,centerX:.74,centerY:.64}},
  {id:"hero",asset:1,frame:{schema:"editkin.floating-video-frame/v1",style:"matte",aspect:"portrait",size:.62,yawDegrees:0,pitchDegrees:0,centerX:.54,centerY:.585}},
];
function keyframe(id:string,time:number,transform:Partial<Transform2D>,easing:ClipKeyframe["easing"]="ease_in_out"):ClipKeyframe{
  return {id,time,transform:{...DEFAULT_TRANSFORM,...transform},color:{...DEFAULT_COLOR},easing};
}
for(const item of frames){
  const track={id:`track-${item.id}`,name:item.id,kind:"video" as const,locked:false,muted:false,clips:[]};
  project=applyCommand(project,{type:"add_track",track});
  // Hold the real action first. Pull back once to reveal its neighbours while
  // every source continues playing; no arbitrary rocking or time reset.
  const close={scale:1.38,x:-29.8,y:-112.6};
  const keyframes=item.id==="hero"
    ? [keyframe("hero-close",0,close,"hold"),keyframe("hero-reveal-start",1.1,close),keyframe("hero-gallery",2.4,{}),keyframe("hero-hold",duration,{})]
    : [keyframe(`${item.id}-hidden`,0,{opacity:0,y:18},"hold"),keyframe(`${item.id}-reveal`,1.35,{opacity:0,y:18}),keyframe(`${item.id}-held`,2.4,{}),keyframe(`${item.id}-end`,duration,{})];
  project=applyCommand(project,{type:"add_clip",clip:{id:item.id,trackId:track.id,assetId:`owned-${item.asset}`,sourceStart:0,timelineStart:0,duration,volume:item.id==="hero"?.5:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes,floatingFrame:item.frame,layer:{enabled:true,role:"content",blendMode:"normal"}}});
}
function heading(id:string,text:string,x:number,y:number,width:number,fontSize:number,color:string,weight=900,start=2.45){
  const seed=structuredClone(findMotionGraphicPreset("reel_spatial_headline").seed);
  const graphic={...createMotionGraphic(id,"title",text,start,duration-start,undefined,seed),x,y,width,fontSize,fontWeight:weight,textColor:color,backgroundColor:"#00000000",accentColor:"#00000000",shadowDepth:0,outlineWidth:0,letterSpacing:0,
    layoutV2:{...seed.layoutV2!,safeArea:{top:0,right:0,bottom:0,left:0},maxLines:2,minFontSize:fontSize,lineGap:4,align:"left" as const},
    motionV2:{...seed.motionV2!,sequence:{unit:"all" as const,order:"forward" as const,exitOrder:"forward" as const,staggerFrames:0},entrance:{...seed.motionV2!.entrance,durationFrames:12,offsetYPixels:8,scale:1},exit:{...seed.motionV2!.exit,durationFrames:1,offsetYPixels:0,scale:1,opacity:1}}};
  const layout=motionGraphicV2LayoutReceipt(project,graphic);
  project=applyCommand(project,{type:"add_motion_graphic",graphic});return {id,box:layout.box};
}
const layouts=[heading("label","陶藝 · 作品展廊",.085,.065,.75,12,"#52647D",700),heading("headline-1","讓作品，",.08,.11,.84,46,"#172033"),heading("headline-2","成為主角。",.08,.167,.84,46,"#175CD3"),heading("footer","每一道曲線，都經過雙手",.08,.93,.84,14,"#52647D",700)];
project=validateProject(JSON.parse(JSON.stringify(project)));
const projectPath=join(evidence,"gallery-diagnostic.editkin.json"),bytes=Buffer.from(JSON.stringify(project,null,2));await writeFile(projectPath,bytes);
const start=performance.now(),result=await renderProject(project,join(evidence,"gallery-diagnostic.mp4"),{ffmpegPath:ffmpeg,ffprobePath:ffprobe,fontRoot:join(root,"public/fonts"),preferGpu:false,timeoutMs:120000});
const renderMs=performance.now()-start;
await run(ffmpeg,["-v","error","-xerror","-i",result.outputPath,"-f","null","-"],{windowsHide:true,timeout:60000});
const {stdout}=await run(ffprobe,["-v","error","-count_frames","-show_streams","-of","json",result.outputPath],{windowsHide:true});const probe=JSON.parse(stdout),video=probe.streams.find((s:any)=>s.codec_type==="video");if(Number(video.nb_read_frames)!==150)throw new Error("Wrong actual frame count");
for(const [i,time] of [1,2.5,4.5].entries())await run(ffmpeg,["-v","error","-y","-ss",String(time),"-i",result.outputPath,"-frames:v","1",join(evidence,`gallery-${i+1}.png`)],{windowsHide:true});
await run(ffmpeg,["-v","error","-y","-i",result.outputPath,"-vf","fps=2,scale=216:-1,tile=5x2","-frames:v","1",join(evidence,"gallery-continuity.png")],{windowsHide:true});
const record={schema:"editkin.motion-art-diagnostic/v1",status:"SOURCE_DIAGNOSTIC_ART_NOT_YET_REVIEWED",sourceOnly:true,notComplete3d:true,installed:false,originalSources:sources,projectSha256:sha(bytes),outputSha256:sha(await readFile(result.outputPath)),renderMs,withinBudget:renderMs<=120000,layouts,decodedFrames:150,probe,result};
await writeFile(join(evidence,"gallery-render.json"),JSON.stringify(record,null,2));process.stdout.write(JSON.stringify({status:record.status,renderMs,decodedFrames:150,outputSha256:record.outputSha256})+"\n");
