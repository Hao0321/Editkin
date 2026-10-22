import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createClipMask } from "../domain/masks";
import { compileColorWindowGeometryV1 } from "../domain/colorWindowGeometryV1";
import type { ColorWindowMaskV1 } from "../domain/colorWindowV1";
import type { MotionTrack } from "../domain/types";
import { colorWindowRasterV1 } from "./colorWindowRasterV1";
import { colorWindowFfmpegFilterV1, colorWindowGeqExpressionV1 } from "./colorWindowFfmpegV1";

const ffmpeg=fileURLToPath(new URL("../../vendor/ffmpeg/win32-x64/ffmpeg.exe",import.meta.url));
const shape=[{id:"a",x:.2,y:.2},{id:"b",x:.8,y:.2},{id:"c",x:.8,y:.8},{id:"d",x:.2,y:.8}];
function fixture(kind:ColorWindowMaskV1["kind"],width=96,height=64) {
  const mask:ColorWindowMaskV1={...createClipMask("window","rectangle"),purpose:"color",kind,path:structuredClone(shape),trackId:"t",opacity:.85,feather:.05,expansion:.01,
    refine:{edgeShift:-.005,contrast:.5,chatterReduction:0}};
  if(kind==="polygon")mask.path[2]={...mask.path[2],x:.45,y:.45};
  if(kind==="linear_gradient"){mask.path=[{id:"a",x:.3,y:.4},{id:"b",x:.8,y:.6}];mask.inverted=true;}
  const points:MotionTrack["points"]=[{frame:0,time:0,rect:{x:.2,y:.2,width:.6,height:.6},quad:[shape[0],shape[1],shape[2],shape[3]],status:"tracked",confidence:1},
    {frame:30,time:1,rect:{x:.1,y:.1,width:.8,height:.8},quad:[{x:.35,y:.1},{x:.9,y:.3},{x:.7,y:.9},{x:.1,y:.65}],status:"tracked",confidence:.8}];
  points.push({...points[1],frame:45,time:1.5,status:"lost"});
  const track:MotionTrack={id:"t",clipId:"c",name:"test",engine:"synthetic-control",analysisFps:30,initialRect:points[0].rect,points,lostRatio:0,createdAt:"fixture"};
  return {mask,geometry:compileColorWindowGeometryV1({mask,clipId:"c",width,height,tracks:[track]})};
}
function decode(g:ReturnType<ReturnType<typeof compileColorWindowGeometryV1>["at"]>,maximum:255|65535) {
  const format=maximum===255?"gray":"gray16le";
  const args=["-hide_banner","-loglevel","error","-f","lavfi","-i",`nullsrc=s=${g.width}x${g.height}:r=30,format=${format}`,
    "-vf",colorWindowFfmpegFilterV1(g,maximum),"-frames:v","1","-pix_fmt",format,"-f","rawvideo","pipe:1"];
  const result=spawnSync(resolve(ffmpeg),args,{windowsHide:true,timeout:10_000,maxBuffer:256*1024});
  expect(result.error).toBeUndefined();expect(result.status,result.stderr.toString()).toBe(0);return result.stdout;
}
function maxError(a:Buffer,b:Buffer,maximum:255|65535) {
  expect(a.length).toBe(b.length);let error=0;
  for(let i=0;i<a.length;i+=maximum===255?1:2)error=Math.max(error,Math.abs(maximum===255?a[i]-b[i]:a.readUInt16LE(i)-b.readUInt16LE(i)));
  return error;
}
describe("real FFmpeg GEQ versus CPU colour-window coverage (no graded-footage parity claim)",()=>{
  it.each(["rectangle","ellipse","polygon","linear_gradient"] as const)("stays within two coverage codes at 8/16-bit: %s",kind=>{
    const {geometry}=fixture(kind);
    for(const maximum of [255,65535] as const)for(const time of [0,.5,1,1.5]) {
      const g=geometry.at(time),reference=colorWindowRasterV1(g,{maximum}),actual=decode(g,maximum);
      expect(maxError(actual,reference,maximum),`${kind} ${maximum} ${time}`).toBeLessThanOrEqual(2);
    }
  },30_000);
  it("matches an independently known binary 4x4 rectangle and detects a broken plane",()=>{
    const {mask}=fixture("rectangle",4,4);delete mask.trackId;mask.opacity=1;mask.feather=mask.expansion=mask.refine.edgeShift=0;
    mask.path=[{id:"a",x:.25,y:.25},{id:"b",x:.75,y:.25},{id:"c",x:.75,y:.75},{id:"d",x:.25,y:.75}];
    const g=compileColorWindowGeometryV1({mask,clipId:"c",width:4,height:4}).at(0),actual=decode(g,255);
    const expected=Buffer.from([0,0,0,0,0,255,255,0,0,255,255,0,0,0,0,0]);expect(actual).toEqual(expected);
    const broken=Buffer.from(actual);broken[0]=10;expect(maxError(broken,expected,255)).toBeGreaterThan(2);
  });
  it("emits only numeric geometry, and lost inverted geometry remains literal zero",()=>{
    const g=fixture("ellipse").geometry.at(0);g.maskId="unexpected:';filter";
    expect(colorWindowGeqExpressionV1(g)).not.toContain("unexpected");
    expect(colorWindowGeqExpressionV1({...g,status:"lost",inverted:true})).toBe("0");
  });
});
