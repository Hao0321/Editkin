import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile,writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { renderMesh3dFrame } from "../src/motion/mesh3dRasterizer";
import { Mesh3dGeometryCache,parseMesh3dFont } from "../src/motion/mesh3dGeometry";
import { readMesh3dFont } from "../src/render/mesh3dFontSource";
const root=resolve(import.meta.dirname,".."),evidence=join(root,".rd/benchmarks/native-mesh3d-20260930"),ffmpeg=join(root,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),run=promisify(execFile),project=JSON.parse(await readFile(join(evidence,"showcase.editkin.json"),"utf8"));
const source=project.assets.find((a:any)=>a.id==="owned-1").uri;
const decoded=await run(ffmpeg,["-v","error","-ss","1.8","-i",source,"-frames:v","1","-vf","scale=360:640:flags=lanczos,format=rgba","-f","rawvideo","pipe:1"],{encoding:"buffer",maxBuffer:8*1024*1024,windowsHide:true});
const font=await readMesh3dFont(join(root,"public/fonts"),900),cache=new Mesh3dGeometryCache(new Map([[900,parseMesh3dFont(new Uint8Array(font).buffer)]])),frame=renderMesh3dFrame(project.scene3d,5.8,810,1440,cache,new Map([["texture-1",{width:360,height:640,rgba:decoded.stdout}]]));
const raw=join(evidence,"same-frame.rgba"),expectedPath=join(evidence,"same-frame-downsample.rgba");await writeFile(raw,frame.rgba);
try{
  await run(ffmpeg,["-v","error","-y","-f","rawvideo","-pix_fmt","rgba","-s","810x1440","-i",raw,"-frames:v","1","-vf","scale=540:960:flags=lanczos","-f","rawvideo",expectedPath],{windowsHide:true});
  const expected=await readFile(expectedPath),actual=await run(ffmpeg,["-v","error","-ss","5.8","-i",join(evidence,"showcase.mp4"),"-frames:v","1","-pix_fmt","rgba","-f","rawvideo","pipe:1"],{encoding:"buffer",maxBuffer:8*1024*1024,windowsHide:true});
  if(expected.length!==actual.stdout.length)throw new Error("同影格像素尺寸不符");let sum=0,max=0,count=0;
  for(let i=0;i<expected.length;i++)if(i%4!==3){const difference=Math.abs(expected[i]-actual.stdout[i]);sum+=difference;max=Math.max(max,difference);count++;}
  const report={schema:"editkin.mesh3d-shared-frame-comparison/v1",timeSeconds:5.8,sourceTime:1.8,executor:"shared-cpu-triangle-zbuffer/v1",delivery:{width:540,height:960},meanAbsoluteRgbDifference:sum/count,maxRgbDifference:max,comparison:"same owned decoded source + shared geometry/camera versus actual two-stage H.264/Rec.709 delivery",limits:"lossy encoding/color conversion; not a direct screenshot equality or an art verdict"};await writeFile(join(evidence,"pixel-comparison.json"),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+"\n");
}finally{
  // Exact files created by this invocation; never recursively delete source or media roots.
  const {unlink}=await import("node:fs/promises");await unlink(raw);await unlink(expectedPath).catch(()=>undefined);
}
