import { beforeEach,describe,expect,it,vi } from "vitest";
import { encoderProbeCanvasV1,encoderProbeFiltersV1 } from "./encoderProbeCanvasV1";
import { chooseEncoder,encoderArgs } from "./ffmpegComposite";
import { withRenderLifetime } from "./renderLifetime";
const controls=vi.hoisted(()=>({run:vi.fn()}));
vi.mock("./ffmpegMedia",async original=>({...await original<typeof import("./ffmpegMedia")>(),runProcess:controls.run}));
beforeEach(()=>{controls.run.mockReset();controls.run.mockResolvedValue({stdout:"",stderr:""});});
describe("bounded target-aware encoder probe",()=>{
 it("retains legacy size, represents small axes exactly and caps large probe allocations",()=>{
  expect(encoderProbeCanvasV1()).toEqual({width:640,height:360});expect(encoderProbeCanvasV1({width:36,height:64})).toEqual({width:36,height:64});expect(encoderProbeCanvasV1({width:3840,height:64})).toEqual({width:640,height:64});expect(encoderProbeCanvasV1({width:36,height:2160})).toEqual({width:36,height:360});expect(encoderProbeCanvasV1({width:7680,height:4320})).toEqual({width:640,height:360});
  expect(encoderProbeFiltersV1({width:37,height:65},false)).toBe("scale=37:65,format=yuv420p");expect(encoderProbeFiltersV1({width:36,height:64},true)).toBe("scale=36:64,format=p010le");
 });
 it("rejects unsafe, nonpositive and nonnumeric geometry instead of passing injected filters",()=>{
  for(const width of[0,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"36:foo"])expect(()=>encoderProbeCanvasV1({width:width as number,height:64})).toThrow("CANVAS_INVALID");expect(()=>encoderProbeCanvasV1(null as never)).toThrow("CANVAS_INVALID");
 });
 it("CPU preference bypasses hardware probing and retains original codec quality settings",async()=>{
  expect(await chooseEncoder("owned-ffmpeg",false,1000,false,{width:36,height:64})).toBe("libx264");expect(await chooseEncoder("owned-ffmpeg",false,1000,true,{width:36,height:64})).toBe("libx265");expect(controls.run).not.toHaveBeenCalled();expect(encoderArgs("libx264")).toEqual(["-c:v","libx264","-preset","veryfast","-crf","18"]);
 });
 it("available platform hardware is actually probed with target geometry before selection",async()=>{
  const result=await chooseEncoder("owned-ffmpeg",true,1000,false,{width:36,height:64});
  if(process.platform!=="win32"&&process.platform!=="darwin"){expect(result).toBe("libx264");expect(controls.run).not.toHaveBeenCalled();return;}
  expect(result).toBe(process.platform==="win32"?"h264_nvenc":"h264_videotoolbox");const args=controls.run.mock.calls[0][1] as string[];expect(args[args.indexOf("-i")+1]).toContain("s=36x64");expect(args[args.indexOf("-vf")+1]).toBe("scale=36:64,format=yuv420p");expect(args[args.indexOf("-frames:v")+1]).toBe("1");expect(args.at(-1)).toBe("-");
 });
 it("failed small hardware initialization falls back without resizing or lowering CPU quality",async()=>{
  controls.run.mockRejectedValue(Error("Frame Dimension less than minimum"));expect(await chooseEncoder("owned-ffmpeg",true,1000,false,{width:36,height:64})).toBe("libx264");expect(encoderArgs("libx264")).toContain("18");
 });
 it("HDR hardware probe keeps ten-bit format and the original HEVC family on failure",async()=>{
  controls.run.mockRejectedValue(Error("small HDR unsupported"));expect(await chooseEncoder("owned-ffmpeg",true,1000,true,{width:36,height:64})).toBe("libx265");
  if(controls.run.mock.calls.length){const args=controls.run.mock.calls[0][1] as string[];expect(args[args.indexOf("-vf")+1]).toBe("scale=36:64,format=p010le");expect(args[args.indexOf("-profile:v")+1]).toBe("main10");}
 });
 it("cancellation is rethrown and cannot be mistaken for a supported software fallback",async()=>{
  const controller=new AbortController(),reason=Error("CONTROL_ENCODER_CANCEL");controls.run.mockImplementation(async()=>{controller.abort(reason);throw reason;});
  if(process.platform==="win32"||process.platform==="darwin")await expect(withRenderLifetime({signal:controller.signal},()=>chooseEncoder("owned-ffmpeg",true,1000,false,{width:36,height:64}))).rejects.toBe(reason);
  else expect(await chooseEncoder("owned-ffmpeg",true,1000,false,{width:36,height:64})).toBe("libx264");
 });
});
