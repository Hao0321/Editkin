import { describe, expect, it } from "vitest";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {linearWhiteBalanceFilters,solveLinearWhiteBalanceStops,rec709OetfDecodeFilters,rec709OetfEncodeFilters,decodeRec709Oetf,encodeRec709Oetf} from "./linearWhiteBalance";
const exe=process.platform==="win32"?resolve(fileURLToPath(new URL("../../",import.meta.url)),"vendor/ffmpeg/win32-x64/ffmpeg.exe"):"ffmpeg";
function run(pixels:number[][], filters:string[], alpha:boolean) {
  const input=Buffer.alloc(pixels.length*(alpha?4:3)*4), channels=alpha?[1,2,0,3]:[1,2,0];
  channels.forEach((c,plane)=>pixels.forEach((p,i)=>input.writeFloatLE(p[c],(plane*pixels.length+i)*4)));
  const format=alpha?"gbrapf32le":"gbrpf32le";
  const result=spawnSync(exe,["-v","error","-nostdin","-f","rawvideo","-pixel_format",format,"-video_size","2x2","-i","pipe:0","-vf",filters.join(",")||"null","-frames:v","1","-f","rawvideo","-pix_fmt",format,"pipe:1"],{input,windowsHide:true,timeout:10000});
  if(result.error||result.status!==0)throw Error(`FFmpeg:${result.error??result.stderr.toString()}`);
  expect(result.stdout.length).toBe(input.length);
  return {input,output:result.stdout,values:pixels.map((_,i)=>(alpha?[2,0,1,3]:[2,0,1]).map(plane=>result.stdout.readFloatLE((plane*pixels.length+i)*4)))};
}
describe("real FFmpeg float linear gain primitive",()=>{
  it("uses explicit camera OETF scalar/FFmpeg semantics with HDR and alpha retained",()=>{
    const pixels=[[137/255,128/255,119/255,0],[.04,.5,1,.25],[-.1,1.2,2,.75],[0,.08,.082,1]];
    const inverse=(v:number)=>v<.081?v/4.5:Math.pow((v+.099)/1.099,1/.45);
    const forward=(v:number)=>v<.018?v*4.5:1.099*Math.pow(v,.45)-.099;
    const decoded=run(pixels,rec709OetfDecodeFilters(),true);
    decoded.values.forEach((p,i)=>p.slice(0,3).forEach((v,c)=>{
      expect(Math.abs(v-inverse(pixels[i][c]))).toBeLessThan(2e-6);
      expect(decodeRec709Oetf(pixels[i][c])).toBe(inverse(pixels[i][c]));
    }));
    expect(decoded.output.subarray(48).equals(decoded.input.subarray(48))).toBe(true);
    const encoded=run(pixels,rec709OetfEncodeFilters(),true);
    encoded.values.forEach((p,i)=>p.slice(0,3).forEach((v,c)=>{
      expect(Math.abs(v-forward(pixels[i][c]))).toBeLessThan(2e-6);
      expect(encodeRec709Oetf(pixels[i][c])).toBe(forward(pixels[i][c]));
    }));
    expect(encoded.output.subarray(48).equals(encoded.input.subarray(48))).toBe(true);
  });
  it.each([false,true])("retains HDR, negative gamut values and alpha; alpha=%s",alpha=>{
    const pixels=[[.3,.25,.2,0],[2,1.8,1.2,.25],[-.1,.2,.3,.75],[0,0,0,1]];
    const identity=run(pixels,linearWhiteBalanceFilters({}),alpha); expect(identity.output.equals(identity.input)).toBe(true);
    const actual=run(pixels,linearWhiteBalanceFilters({whiteBalanceRed:1,whiteBalanceGreen:-1,whiteBalanceBlue:.5}),alpha);
    actual.values.forEach((p,i)=>p.slice(0,3).forEach((v,c)=>expect(Math.abs(v-pixels[i][c]*[2,.5,Math.SQRT2][c])).toBeLessThan(2e-6)));
    if(alpha)expect(actual.output.subarray(48).equals(actual.input.subarray(48))).toBe(true);
  });
  it("preserves strong 137/128/119 baseline and rejects applying gains to encoded RGB",()=>{
    const encoded=[137,128,119].map(v=>v/255), decode=(v:number)=>v<.081?v/4.5:((v+.099)/1.099)**(1/.45);
    const rgb=encoded.map(decode), solution=solveLinearWhiteBalanceStops(rgb as [number,number,number],{},1);
    const error=(v:number[])=>Math.log2(Math.max(...v)/Math.min(...v));
    expect(error(rgb)).toBeGreaterThan(.3);
    const color={whiteBalanceRed:solution.stops[0],whiteBalanceGreen:solution.stops[1],whiteBalanceBlue:solution.stops[2]};
    const actual=run(Array.from({length:4},()=>rgb),linearWhiteBalanceFilters(color),false).values[0];
    expect(error(actual)).toBeLessThan(.08);
    expect(error(encoded.map((v,i)=>decode(v*2**solution.stops[i])))).toBeGreaterThan(.08);
  });
});
