// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { clipAudioGainAt, withClipAudioFades, withClipVolumePoint, shiftedClipAudioEnvelope } from "../domain/clipAudioEnvelope";
import { clipAudioEnvelopeFilter } from "../render/clipAudioEnvelopeFilters";
import { stageNativeAudioPreview } from "./nativeAudioPreview";
import { exportVideo } from "./exportVideo";
import { runConversionProcess } from "./mediaConversion";

const app=resolve(import.meta.dirname,"../.."),work=join(app,".rd/benchmarks/usable-v1-20261009/work/codex-long-2");
const ffmpeg=join(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobe=join(app,"vendor/ffmpeg/win32-x64/ffprobe.exe");
const core=join(app,"native/hao-core/target/release/hao-core.exe"),attempt=process.env.EDITKIN_AUDIO_ENVELOPE_RECEIPTS;
let root:string,tone:string;const evidence:Record<string,unknown>[]=[];
const sha=(raw:Uint8Array)=>createHash("sha256").update(raw).digest("hex");
beforeAll(async()=>{
  if(attempt&&!/^[A-Z0-9_]+$/.test(attempt))throw Error("Invalid owned evidence label");
  root=attempt?join(work,"media",attempt.toLowerCase()):await mkdtemp(join(tmpdir(),"editkin-audio-envelope-"));
  if(attempt)await mkdir(root);tone=join(root,"owned-tone.wav");
  await runConversionProcess(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-n","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=7","-c:a","pcm_s16le",tone]);
},60000);
afterAll(async()=>{
  if(!root)return;
  if(attempt)await writeFile(join(work,`${attempt}_PCM.json`),JSON.stringify({status:evidence.length===3?"PHYSICAL_FFMPEG_NATIVE_PCM_GREEN":"INCOMPLETE",evidence,root,
    browserEvidence:"separate owned CDP OfflineAudioContext run",nativeDeviceOutputCertified:false},null,2)+"\n",{flag:"wx"});
  else{if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith("editkin-audio-envelope-"))throw Error("Unowned cleanup");await rm(root,{recursive:true,force:true});}
});
function decode(args:string[]){const child=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-nostdin",...args,"-ar","48000","-ac","2","-f","f32le","pipe:1"],{windowsHide:true,timeout:60000,maxBuffer:8_000_000});
  if(child.status!==0)throw Error(child.stderr.toString());return child.stdout;}
function samples(raw:Buffer){return new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));}
function curveError(actual:Float32Array,reference:Float32Array,clip:ReturnType<typeof audioEnvelopeFixture>["clip"]){
  let worst=0,windows=0;const count=Math.min(actual.length,reference.length)/2;
  for(let begin=0;begin<count;begin+=192){let got=0,want=0;
    for(let frame=begin;frame<Math.min(count,begin+192);frame++){got+=actual[frame*2]**2;want+=(reference[frame*2]*clipAudioGainAt(clip,frame/48000))**2;}
    if(want>1e-12){worst=Math.max(worst,Math.abs(10*Math.log10(Math.max(1e-30,got)/want)));windows++;}
  }
  expect(windows).toBeGreaterThan(500);return {worstDb:worst,windows,frames:count};
}
describe("physical PCM follows the authored envelope through real FFmpeg and Rust native DAG execution",()=>{
  it("measures three nonclipping curves including +6 dB and preserved trim offsets",async()=>{
    const coreBefore=sha(await readFile(core));
    for(const variant of ["fades","points","trim"]){
      const {project,clip}=audioEnvelopeFixture();project.assets[0].uri=tone;project.assets[0].duration=7;clip.timelineStart=0;clip.sourceStart=.2;clip.duration=4;clip.volume=variant==="fades"?.8:1.25;
      clip.audioEnvelope=withClipAudioFades(clip,1,1);
      if(variant!=="fades")for(const [index,time,db] of [[0,0,-30],[1,1.4,6],[2,2.8,-12],[3,4,3]])clip.audioEnvelope=withClipVolumePoint(clip,{id:`p${index}`,time,db});
      if(variant==="trim"){clip.audioEnvelope=shiftedClipAudioEnvelope(clip,.5);clip.sourceStart+=.5;clip.duration-=.5;}
      const reference=decode(["-ss",String(clip.sourceStart),"-i",tone,"-t",String(clip.duration)]);
      const filter=`aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${clip.duration},asetpts=PTS-STARTPTS${clipAudioEnvelopeFilter(clip)},volume=${clip.volume}`;
      const exported=decode(["-ss",String(clip.sourceStart),"-i",tone,"-t",String(clip.duration),"-af",filter]);
      const stage=await stageNativeAudioPreview(project,{ffmpegPath:ffmpeg,ffprobePath:ffprobe,cacheRoot:join(root,`preview-${variant}`),timelineStartSeconds:0,maxDurationSeconds:clip.duration});
      const nativePath=join(root,`native-${variant}.f32le`),native=spawnSync(core,["audio-preview-mix",stage.manifestPath,nativePath],{windowsHide:true,timeout:60000,maxBuffer:1_000_000});
      expect(native.status,native.stderr.toString()).toBe(0);const nativePcm=await readFile(nativePath);
      const exportedError=curveError(samples(exported),samples(reference),clip),nativeError=curveError(samples(nativePcm),samples(reference),clip);
      expect(exportedError.worstDb).toBeLessThanOrEqual(1);expect(nativeError.worstDb).toBeLessThanOrEqual(1);
      await writeFile(join(root,`export-filter-${variant}.f32le`),exported,{flag:"wx"});await writeFile(join(root,`reference-${variant}.f32le`),reference,{flag:"wx"});
      if(variant==="points"){
        const output=join(root,"wired-audio-export.mp4");const rendered=await exportVideo({project,outputPath:output,options:{ffmpegPath:ffmpeg,ffprobePath:ffprobe,preferGpu:false,workRoot:join(root,"wired-export"),timeoutMs:120000}});
        const decoded=samples(decode(["-i",output,"-vn"]));expect(Math.max(...decoded.slice(48000*2,48000*2+1000))).toBeGreaterThan(.01);
        evidence.push({variant,clip,project,filter,exportedError,nativeError,referenceSha:sha(reference),exportedSha:sha(exported),nativeSha:sha(nativePcm),nativeExit:native.status,nativeReceipt:JSON.parse(native.stdout.toString()),rendered});
      }else evidence.push({variant,clip,project,filter,exportedError,nativeError,referenceSha:sha(reference),exportedSha:sha(exported),nativeSha:sha(nativePcm),nativeExit:native.status,nativeReceipt:JSON.parse(native.stdout.toString())});
    }
    expect(sha(await readFile(core))).toBe(coreBefore);
  },180000);
});
