import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, copyFile, rm, access, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR } from "../domain/types";
import { createSpeedCurvePresetV1 } from "../application/speedCurvePresetsV1";
import { planTimeRemapExportWindowsV1 } from "./timeRemapExportWindowPlanV1";
import { renderTimeRemapSourceProjectV1, SOURCE_CLOCK_RENDER_POLICY_V1 } from "./timeRemapSourceRenderV1";
import { renderTimeRemapSourceWindowV1, openSourceClockIndexSessionV1 } from "./timeRemapSourceWindowV1";
import { assertTimeRemapLocalPathV1 } from "./timeRemapCacheIdentityV1";
const ffmpeg=resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobe=resolve("vendor/ffmpeg/win32-x64/ffprobe.exe"),run=promisify(execFile),sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
let root:string,source:string,sourceSha:string;const receipts:unknown[]=[];
beforeAll(async()=>{
  root=await mkdtemp(join(resolve(process.env.TEMP!),"h8-window-native-"));source=join(root,"original-with-audio.mp4");
  await run(ffmpeg,["-n","-v","error","-f","lavfi","-i","testsrc2=s=64x36:r=8:d=4","-f","lavfi","-i","sine=frequency=777:sample_rate=48000:duration=4","-map","0:v:0","-map","1:a:0","-c:v","libx264","-g","1","-bf","0","-pix_fmt","yuv420p","-color_primaries:v:0","bt709","-color_trc:v:0","bt709","-colorspace:v:0","bt709","-color_range:v:0","tv","-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off","-c:a","aac",source],{windowsHide:true,timeout:30000});
  sourceSha=sha(await readFile(source));
  const color=JSON.parse((await run(ffprobe,["-v","error","-select_streams","v:0","-show_entries","stream=color_space,color_range,color_transfer,color_primaries","-of","json",source],{windowsHide:true,timeout:30000})).stdout).streams[0];
  expect(color).toMatchObject({color_primaries:"bt709",color_transfer:"bt709",color_space:"bt709",color_range:"tv"});
});
afterAll(async()=>{
  if(!root)return;const owned=resolve(root),temp=resolve(process.env.TEMP!);if(!owned.startsWith(temp+sep))throw Error("H8_TEST_CLEANUP_OUTSIDE_OWNED_TEMP");
  await assertTimeRemapLocalPathV1(root);
  // Actual output artifacts, not only self-declared success labels, are retained by the wave runner.
  if(process.env.EDITKIN_H8_EVIDENCE_ROOT){const E=resolve(process.env.EDITKIN_H8_EVIDENCE_ROOT),retained=join(E,"native-window-retained",basename(root));await mkdir(retained,{recursive:true});const files=[],missing=[];
    for(const name of ["original-with-audio.mp4","forward-full.mkv","reverse-full.mkv","forward-0.mkv","forward-1.mkv","forward-2.mkv","forward-3.mkv","reverse-0.mkv","reverse-1.mkv","reverse-2.mkv","reverse-3.mkv"]){
      const present=await stat(join(root,name)).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});if(!present){missing.push(name);continue;}
      await copyFile(join(root,name),join(retained,name),constants.COPYFILE_EXCL);files.push({name,bytes:present.size,sha256:sha(await readFile(join(retained,name)))});
    }
    await writeFile(join(retained,"RECEIPTS.json"),JSON.stringify({receipts,files,missing,sourceSha256:sourceSha},null,2),{flag:"wx"});
  }
  console.log("H8_WINDOW_ACTUAL_RECEIPTS="+JSON.stringify(receipts));await rm(root,{recursive:true});
});
function project(direction:"forward"|"reverse"){
  const p=createEmptyProject("H8 windows",{id:"h8-window",width:64,height:36,fps:8});
  p.assets=[{id:"original",name:"owned original",uri:source,kind:"video",duration:4,width:64,height:36,license:"synthetic local fixture",provenance:"testsrc2 + sine",redistributable:true,
    color:{interpretation:"rec709",primaries:"bt709",transfer:"bt709",matrix:"bt709",range:"tv"},derivatives:{sourceSha256:sourceSha,proxyUri:join(root,"MUST_NOT_READ_PROXY.mp4"),proxyWidth:16,proxyHeight:9,generatedAt:"2026-10-18T00:00:00Z"}}];
  const curve=createSpeedCurvePresetV1("montage",{audioMode:"mute"});curve.direction=direction;
  p.tracks[0].clips=[{id:"authored",assetId:"original",trackId:p.tracks[0].id,timelineStart:3.25,sourceStart:.125,duration:1,volume:.6,transform:{...DEFAULT_TRANSFORM,x:.1,scale:1.2},color:{...DEFAULT_COLOR,brightness:.1},keyframes:[],timeRemap:curve}];return p;
}
describe("actual encoded/decoded V4 windows from the H8 lazy export plan",()=>{
  it.each(["forward","reverse"] as const)("matches every %s moving montage frame to the full original diagnostic and shares one source/index",async direction=>{
    const p=project(direction),before=structuredClone(p),plan=planTimeRemapExportWindowsV1(p,{sourceSha256ByAssetId:{original:sourceSha},limits:{maximumWindowSeconds:.25,maximumWindowMediaBytes:4*1024**2}});
    // Independent full neutral reference: do not derive it from the candidate window stage.
    const reference=createEmptyProject("reference",{id:"reference",width:64,height:36,fps:8});reference.assets=[{...structuredClone(p.assets[0]),derivatives:undefined}];
    reference.tracks[0].clips=[{id:"full",assetId:"original",trackId:reference.tracks[0].id,timelineStart:0,sourceStart:.125,duration:1,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],timeRemap:structuredClone(p.tracks[0].clips[0].timeRemap!)}];
    const full:Buffer[]=[],ref=await renderTimeRemapSourceProjectV1(reference,join(root,`${direction}-full.mkv`),{ffmpegPath:ffmpeg,ffprobePath:ffprobe,assetBase:root,expectedSourceSha256:sourceSha,policy:SOURCE_CLOCK_RENDER_POLICY_V1,maximumOutputBytes:4*1024**2,timeoutMs:30000,onFrame:async f=>{full[f.index]=Buffer.from(f.bytes);}});
    const session=await openSourceClockIndexSessionV1({sourcePath:source,expectedSourceSha256:sourceSha,ffmpegPath:ffmpeg,ffprobePath:ffprobe,projectRoot:root,helperTemporaryRoot:resolve(process.env.TEMP!),timeoutMs:30000});
    const windows=[];try{
      for(let i=0;i<plan.clips[0].windows;i++){
        const w=plan.window("authored",i),indices:number[]=[];
        const rendered=await renderTimeRemapSourceWindowV1(w.sourceStage,join(root,`${direction}-${i}.mkv`),{ffmpegPath:ffmpeg,ffprobePath:ffprobe,assetBase:root,expectedSourceSha256:w.sourceSha256,
          outputFrameWindow:w.outputFrameWindow,sourceIndexSession:session,maximumOutputBytes:plan.limits.maximumWindowMediaBytes,timeoutMs:30000,
          onFrame:async f=>{expect(Buffer.from(f.bytes)).toEqual(full[f.index]);indices.push(f.index);}});
        expect(indices).toEqual([i*2,i*2+1]);expect(rendered.globalClockSha256).toBe(w.clockSha256);expect(rendered.sourceColorMetadata?.interpretationUnresolved).toBe(false);
        expect(rendered.outputPixels.sha256).toBe(rendered.sampledPixelSha256);expect(rendered.frames).toBe(2);expect(rendered.duration).toBe(.25);expect(rendered.originalAudio).toBe("explicitly_muted");
        windows.push({index:i,firstFrame:w.outputFrameWindow.firstFrame,frames:rendered.frames,bytes:rendered.bytes,pixelSha256:rendered.outputPixels.sha256,decoder:rendered.frameConsumer,encoderClosed:rendered.encoder.closed});
      }
      expect(session.receipt).toMatchObject({sourceHashes:1,indexBuilds:1,borrows:4});
    }finally{await session.close();}
    expect(p).toEqual(before);expect(sha(await readFile(source))).toBe(sourceSha);expect(session.receipt.closed).toBe(true);
    receipts.push({direction,status:"EXACT_FULL_DIAGNOSTIC_FRAME_IDENTITY",originalSha256:sourceSha,originalProjectUnchanged:true,fullPixelSha256:ref.outputPixels.sha256,windows,index:session.receipt,ordinaryExportIntegrated:false});
  },30000);
  it("refuses following source audio instead of producing an accidentally silent video-only window",async()=>{
    const p=project("forward");delete p.tracks[0].clips[0].timeRemap;p.tracks[0].clips[0].speed=.5;
    const w=planTimeRemapExportWindowsV1(p,{sourceSha256ByAssetId:{original:sourceSha},limits:{maximumWindowSeconds:.25}}).window("authored",0);
    const session=await openSourceClockIndexSessionV1({sourcePath:source,expectedSourceSha256:sourceSha,ffmpegPath:ffmpeg,ffprobePath:ffprobe,projectRoot:root,helperTemporaryRoot:resolve(process.env.TEMP!),timeoutMs:30000}),output=join(root,"MUST_NOT_PUBLISH_SILENT.mkv");
    try{await expect(renderTimeRemapSourceWindowV1(w.sourceStage,output,{ffmpegPath:ffmpeg,ffprobePath:ffprobe,assetBase:root,expectedSourceSha256:sourceSha,outputFrameWindow:w.outputFrameWindow,sourceIndexSession:session,maximumOutputBytes:4*1024**2,timeoutMs:30000})).rejects.toThrow("ORIGINAL_AUDIO_CONSUMER_REQUIRED");
      await expect(access(output)).rejects.toMatchObject({code:"ENOENT"});expect(session.receipt.indexBuilds).toBe(0);
    }finally{await session.close();}
    receipts.push({status:"FOLLOWING_AUDIO_REFUSED_BEFORE_INDEX_AND_PUBLICATION",sourceSha256:sourceSha,index:session.receipt});
  },30000);
});
