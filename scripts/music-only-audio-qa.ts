import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseProject } from "../src/application/projectFiles";
import type { EditProject } from "../src/domain/types";
import { buildRenderPlan } from "../src/render/planner";
import { resolveMediaPath } from "../src/render/ffmpegMedia";
import { renderReviewContentJson } from "../src/shared/renderReviewContent";
import type { RenderResult } from "../src/render/ffmpegTypes";
import { materializeCreativeAssets, creativeAssetIdFromUri } from "../src/application/creativeLibrary";

const rate=48000, channels=2;
async function hash(path:string){const before=await stat(path),h=createHash("sha256");for await(const b of createReadStream(path))h.update(b);const after=await stat(path);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error("Input changed during hash");return h.digest("hex");}
export function assertMusicOnlyProject(project:EditProject,id:string,assetBase?:string){
 const asset=project.assets.find(a=>a.id===id);if(!asset||asset.kind!=="audio"||asset.role!=="background-music")throw Error("Specified library BGM missing or wrong role");
 for(const track of project.tracks)for(const clip of track.clips){const a=project.assets.find(a=>a.id===clip.assetId);if(a?.kind==="video"&&clip.volume!==0)throw Error("Original video volume must be exactly zero");if(a?.kind==="audio"&&a.id!==id&&clip.volume>0&&!track.muted&&clip.layer?.enabled!==false)throw Error("Separate original/other audio bypass");}
 const plan=buildRenderPlan(project,uri=>resolveMediaPath(uri,assetBase));
 if(!plan.audioClips.length||plan.audioClips.some(i=>i.clip.assetId!==id||i.clip.volume<=0))throw Error("Missing/muted music or unexpected audio plan");
 if(plan.duration>120)throw Error("Audio QA bounded to 120 seconds");return{asset,plan};
}
export function compareMusicPcm(reference:Buffer,actual:Buffer){
 if(reference.length!==actual.length||reference.length===0||reference.length%8)throw Error("PCM duration/channel mismatch");
 const windows=[];const samples=reference.length/4,step=rate*channels/2;
 for(let start=0;start<samples;start+=step){let rr=0,aa=0,ra=0,ee=0;const end=Math.min(samples,start+step);
  for(let n=start;n<end;n++){const r=reference.readFloatLE(n*4),a=actual.readFloatLE(n*4);if(!Number.isFinite(r)||!Number.isFinite(a))throw Error("Nonfinite audio sample");rr+=r*r;aa+=a*a;ra+=r*a;ee+=(a-r)**2;}
  const referenceRms=Math.sqrt(rr/(end-start)),actualRms=Math.sqrt(aa/(end-start));
  const correlation=rr&&aa?ra/Math.sqrt(rr*aa):0,residualRatio=rr?Math.sqrt(ee/rr):null,levelDeltaDb=rr&&aa?10*Math.log10(aa/rr):null;
  const active=referenceRms>0.0001,pass=active?correlation>=.995&&residualRatio!==null&&residualRatio<=.10&&levelDeltaDb!==null&&Math.abs(levelDeltaDb)<=.5:actualRms<=.001;
  windows.push({startSeconds:start/(rate*channels),referenceRms,actualRms,correlation,residualRatio,levelDeltaDb,active,pass});
 }
 return{pass:windows.some(w=>w.active)&&windows.every(w=>w.pass),windows,thresholds:{correlation:.995,maxResidualRatio:.10,maxLevelDeltaDb:.5,silenceRms:.001},limits:"Bounded decoded PCM comparison; not mathematical source separation, subjective listening or detection below tolerance."};
}
/** Independent pre-AAC proof plus exact render-master identity. AAC is lossy:
 * tiny floating-point differences may change its quantization decisions. */
export function verifyNativeMusicMaster(reference:Buffer,master:Buffer,expectedSha256:string){
 if(!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error("Invalid native master SHA256");
 const sha256=createHash("sha256").update(master).digest("hex");
 if(sha256!==expectedSha256)throw Error("Native master hash mismatch with render receipt");
 const metrics=compareMusicPcm(reference,master);
 if(!metrics.pass)throw Error("Native master differs from independent music-only PCM");
 return{sha256,bytes:master.length,metrics};
}
function run(ffmpeg:string,args:string[],binary=false){const r=spawnSync(ffmpeg,args,{windowsHide:true,timeout:90000,maxBuffer:120*rate*channels*4+1000000});if(r.status!==0)throw Error(r.stderr.toString().slice(-3000));return binary?r.stdout:r.stdout.toString();}
export async function runMusicOnlyQa(input:{project:EditProject;output:string;musicAssetId:string;musicSha256:string;renderResult:RenderResult;ffmpegPath:string;assetBase?:string;creativePackRoot?:string;personalMusicRoot?:string;nativeMasterPath?:string}){
 const dir=await mkdtemp(join(tmpdir(),"editkin-final-music-qa-"));
 try{
  if(input.project.assets.some(a=>creativeAssetIdFromUri(a.uri))&&!input.creativePackRoot)throw Error("Creative URI requires explicit creativePackRoot");
  // Match MCP's in-memory materialization before render identity; never rewrite stored project.
  const project=input.creativePackRoot?await materializeCreativeAssets(input.project,input.creativePackRoot,input.personalMusicRoot):input.project;
  const{asset,plan}=assertMusicOnlyProject(project,input.musicAssetId,input.assetBase);
  if(!/^[a-f0-9]{64}$/.test(input.musicSha256))throw Error("Expected exact music SHA256");
  const musicPath=resolveMediaPath(asset.uri,input.assetBase),musicSha=await hash(musicPath),outputSha=await hash(input.output);
  if(musicSha!==input.musicSha256)throw Error("Selected BGM hash mismatch");
  const identity=input.renderResult.artifactIdentity,contentSha=createHash("sha256").update(renderReviewContentJson(project)).digest("hex");
  if(!identity||identity.outputSha256!==outputSha||identity.projectContentSha256!==contentSha)throw Error("Render artifact/project identity mismatch");
  const native=input.renderResult.nativeAudio;
  if(input.nativeMasterPath&&!native)throw Error("Native master requires a native render receipt");
  if(native&&(native.status!=="GREEN"||native.mixExecutor!=="hao-core-native-dag/v1"||!native.nativeGraphExecution||native.voiceClipCount!==0||native.musicClipCount!==plan.audioClips.length||native.limiterCeilingDb!==-3||Math.abs(native.durationSeconds-plan.duration)>1/48000))throw Error("Unsupported or mismatched native audio receipt");
  const raw=join(dir,"reference.f32le"),aac=join(dir,"reference.m4a"),frames=Math.round(plan.duration*rate);
  if(native){
   const mix=new Float32Array(frames*channels);
   for(const{clip}of plan.audioClips){
    const decoded=run(input.ffmpegPath,["-v","error","-ss",String(clip.sourceStart),"-t",String(clip.duration),"-i",musicPath,"-map","0:a:0","-vn","-af",`aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,atrim=duration=${clip.duration}`,"-ar","48000","-ac","2","-f","f32le","-"],true) as Buffer;
    const count=Math.ceil(clip.duration*rate),last=(count-1)/rate,fade=Math.min(1.2,clip.duration/5),offset=Math.round(clip.timelineStart*rate),points=new Map<number,number>();
    for(const t of [0,fade,clip.duration-fade,clip.duration,last].filter(t=>t>=0&&t<=last))points.set(Math.min(frames-1,offset+Math.round(t*rate)),Math.max(-144,20*Math.log10(Math.max(10**(-144/20),clip.volume*Math.max(0,Math.min(1,t/fade,(clip.duration-t)/fade))))));
    const sorted=[...points].sort((a,b)=>a[0]-b[0]);let p=0;
    for(let n=0;n<Math.min(decoded.length/8,count)&&offset+n<frames;n++){const absolute=offset+n;while(p+1<sorted.length&&sorted[p+1][0]<=absolute)p++;const a=sorted[p],b=sorted[p+1]??a;const db=a[1]+(b[1]-a[1])*(b[0]===a[0]?0:(absolute-a[0])/(b[0]-a[0]));const gain=10**(db/20);for(let c=0;c<channels;c++)mix[(offset+n)*channels+c]+=decoded.readFloatLE((n*channels+c)*4)*gain;}
   }
   let peak=0;for(const x of mix)peak=Math.max(peak,Math.abs(x));const gain=peak>10**(-3/20)?10**(-3/20)/peak:1;for(let i=0;i<mix.length;i++)mix[i]*=gain;
   await writeFile(raw,Buffer.from(mix.buffer));
  }else{
   const args=["-v","error","-f","lavfi","-t",String(plan.duration),"-i","anullsrc=r=48000:cl=stereo"],filters=[`[0:a]atrim=duration=${plan.duration},asetpts=PTS-STARTPTS[base]`],labels:string[]=[];
   plan.audioClips.forEach(({clip},i)=>{args.push("-ss",String(clip.sourceStart),"-t",String(clip.duration),"-i",musicPath);const fade=Math.min(1.2,clip.duration/5);filters.push(`[${i+1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${clip.duration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade},afade=t=out:st=${clip.duration-fade}:d=${fade},adelay=${Math.round(clip.timelineStart*1000)}:all=1,volume=${clip.volume}[m${i}]`);labels.push(`[m${i}]`);});
   filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[music]`,`[base][music]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-18:LRA=11:TP=-3,atrim=duration=${plan.duration}[out]`);
   run(input.ffmpegPath,[...args,"-filter_complex",filters.join(";"),"-map","[out]","-ar","48000","-ac","2","-f","f32le",raw]);
  }
  let encodingInput=raw,nativeMasterVerification:ReturnType<typeof verifyNativeMusicMaster>|undefined;
  if(native&&input.nativeMasterPath){
   if((await stat(input.nativeMasterPath)).size!==frames*channels*4)throw Error("Native master duration/channel mismatch");
   const master=await readFile(input.nativeMasterPath);
   nativeMasterVerification=verifyNativeMusicMaster(await readFile(raw),master,native.outputSha256);
   // Encode the exact bytes just verified, not an external path that can drift.
   encodingInput=join(dir,"verified-native-master.f32le");await writeFile(encodingInput,master,{flag:"wx"});
  }
  run(input.ffmpegPath,["-v","error","-f","f32le","-ar","48000","-ac","2","-i",encodingInput,...(native?["-af",`loudnorm=I=-18:LRA=11:TP=-3,atrim=duration=${plan.duration}`]:[]),"-t",String(plan.duration),"-ar","48000","-ac","2","-c:a","aac","-b:a","192k",aac]);
  const decode=(path:string)=>run(input.ffmpegPath,["-v","error","-i",path,"-map","0:a:0","-af",`apad,atrim=end_sample=${frames}`,"-ar","48000","-ac","2","-f","f32le","-"],true) as Buffer;
  const metrics=compareMusicPcm(decode(aac),decode(input.output));
  if(await hash(musicPath)!==musicSha||await hash(input.output)!==outputSha)throw Error("Inputs changed during QA");
  if(nativeMasterVerification&&await hash(input.nativeMasterPath!)!==nativeMasterVerification.sha256)throw Error("Native master changed during QA");
  const report={status:metrics.pass?"PASS_BOUNDED_MUSIC_ONLY_AUDIO":"FAIL_AUDIO_COMPARISON",dir,profile:native?"native-gainDb-linear-peaklimit-minus3-then-ffmpeg-loudnorm-v1":"ffmpeg-loudnorm-v1",referenceStrategy:nativeMasterVerification?"independent-pre-aac-plus-render-bound-master":"independent-aac-comparison",nativeMasterVerification,musicPath,musicSha256:musicSha,outputSha256:outputSha,projectContentSha256:contentSha,planAudio:plan.audioClips.map(i=>({clipId:i.clip.id,sourceStart:i.clip.sourceStart,duration:i.clip.duration,timelineStart:i.clip.timelineStart,volume:i.clip.volume})),metrics,subjectiveListening:"NOT_RUN",libraryLicense:"CALLER_PINNED_IDENTITY_NOT_LICENSE_AUDIT"};
  await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));return report;
 }catch(e){await writeFile(join(dir,"report.json"),JSON.stringify({status:"BLOCKED",error:String(e),dir},null,2));throw Error(`${String(e)}; evidence=${dir}`);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const[projectFile,output,musicAssetId,musicSha256,resultFile,assetBase,creativePackRoot,personalMusicRoot,nativeMasterPath]=process.argv.slice(2);
 if(!resultFile)throw Error("Usage: node --import tsx scripts/music-only-audio-qa.ts project.json output.mp4 musicAssetId sha256 renderResult.json [assetBase] [creativePackRoot] [personalMusicRoot] [nativeMasterPath]");
 const report=await runMusicOnlyQa({project:parseProject(JSON.parse(await readFile(projectFile,"utf8"))),output:resolve(output),musicAssetId,musicSha256,renderResult:JSON.parse(await readFile(resultFile,"utf8")),ffmpegPath:resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),assetBase,creativePackRoot,personalMusicRoot,nativeMasterPath});console.log(JSON.stringify(report));if(!report.metrics.pass)process.exitCode=1;
}
