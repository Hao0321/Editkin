import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const ffmpeg=process.env.HAO_FFMPEG_PATH??resolve(root,"vendor","ffmpeg","win32-x64","ffmpeg.exe");
const evidence=resolve(root,"..","..",".rd","benchmarks","editkin-hardware-video-decode");
const sink=process.platform==="win32"?"NUL":"-";

function run(args,{allowFailure=false}={}){
  const started=performance.now();
  const result=spawnSync(ffmpeg,args,{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024});
  const output=`${result.stdout??""}\n${result.stderr??""}`;
  if(!allowFailure&&result.status!==0)throw new Error(`ffmpeg ${args.join(" ")} failed\n${output.slice(-8000)}`);
  return {status:result.status,output,elapsedMs:performance.now()-started};
}

await mkdir(evidence,{recursive:true});
const codecs=[
  {id:"h264",encoder:"h264_nvenc",software:"libx264",path:resolve(evidence,"h264-1080p.mp4")},
  {id:"hevc",encoder:"hevc_nvenc",software:"libx265",path:resolve(evidence,"hevc-1080p.mp4")},
];
for(const codec of codecs){
  let encoded=run(["-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=s=1920x1080:r=30:d=3","-c:v",codec.encoder,"-preset","p4","-pix_fmt","yuv420p",codec.path],{allowFailure:true});
  if(encoded.status!==0)encoded=run(["-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=s=1920x1080:r=30:d=3","-c:v",codec.software,"-preset","ultrafast","-pix_fmt","yuv420p",codec.path]);
}

const hwaccel=process.platform==="win32"?"d3d11va":process.platform==="darwin"?"videotoolbox":"vaapi";
const surfaceFormat=process.platform==="win32"?"d3d11":process.platform==="darwin"?"videotoolbox_vld":"vaapi";
const cases=[];
for(const codec of codecs){
  const args=["-hide_banner","-loglevel","verbose","-hwaccel",hwaccel,"-hwaccel_output_format",surfaceFormat,"-i",codec.path,"-an","-f","null",sink];
  const result=run(args);
  const decoded=Number(result.output.match(/(\d+) frames decoded/)?.[1]??0);
  const resident=result.output.includes(`pixfmt:${surfaceFormat}`)||result.output.includes(`${surfaceFormat}(`);
  const noCpuDownload=!/hwdownload|auto-inserting filter.*format/i.test(result.output);
  cases.push({codec:codec.id,status:resident&&noCpuDownload&&decoded>=85?"GREEN":"BLOCK",decodedFrames:decoded,residentSurfaceFormat:surfaceFormat,noCpuDownload,elapsedMs:result.elapsedMs});
}

const sixLayerArgs=["-hide_banner","-loglevel","verbose"];
for(let index=0;index<6;index++)sixLayerArgs.push("-hwaccel",hwaccel,"-hwaccel_output_format",surfaceFormat,"-ss",String((index%3)*.25),"-i",codecs[index%2].path);
for(let index=0;index<6;index++)sixLayerArgs.push("-map",`${index}:v:0`);
sixLayerArgs.push("-an","-f","null",sink);
const sixLayer=run(sixLayerArgs);
const decodedStreams=[...sixLayer.output.matchAll(/Input stream #(\d+):0 \(video\): \d+ packets read \([^)]*\); (\d+) frames decoded; (\d+) decode errors/g)].map(match=>({input:Number(match[1]),frames:Number(match[2]),errors:Number(match[3])}));
const residentMentions=(sixLayer.output.match(new RegExp(`pixfmt:${surfaceFormat}`,"g"))??[]).length;
const sixLayerGreen=decodedStreams.length===6&&decodedStreams.every(stream=>stream.frames>=80&&stream.errors===0)&&residentMentions>=6&&!/hwdownload/i.test(sixLayer.output);

const seek=run(["-hide_banner","-loglevel","verbose","-hwaccel",hwaccel,"-hwaccel_output_format",surfaceFormat,"-ss","1.37","-i",codecs[0].path,"-frames:v","24","-an","-f","null",sink]);
const seekFrames=Number(seek.output.match(/(\d+) frames encoded/)?.[1]??0);
const negative=run(["-hide_banner","-loglevel","error","-hwaccel",hwaccel,"-hwaccel_output_format",surfaceFormat,"-i",resolve(evidence,"not-a-video.bin"),"-f","null",sink],{allowFailure:true});
const negativeRejected=negative.status!==0;

const report={
  schema:"editkin.hardware-video-decode-gate/v1",status:cases.every(item=>item.status==="GREEN")&&sixLayerGreen&&seekFrames===24&&negativeRejected?"GREEN":"BLOCK",
  contract:"H.264/H.265 decode remains in native hardware surfaces without an explicit CPU download; this gate does not claim wgpu shared-texture interop or direct present.",
  hwaccel,surfaceFormat,cases,sixLayer:{status:sixLayerGreen?"GREEN":"BLOCK",streams:decodedStreams,residentMentions,elapsedMs:sixLayer.elapsedMs},
  seek:{status:seekFrames===24?"GREEN":"BLOCK",frames:seekFrames,offsetSeconds:1.37,elapsedMs:seek.elapsedMs},negativeControl:{corruptInputRejected:negativeRejected},
  evidence:resolve(evidence,"report.json"),
};
await writeFile(report.evidence,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
if(report.status!=="GREEN")process.exitCode=1;
