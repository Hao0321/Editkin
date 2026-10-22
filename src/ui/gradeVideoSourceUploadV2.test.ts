import { afterEach,describe,expect,it,vi } from "vitest";
import {createGradeVideoSourceUploadV2,gradeVideoSourceSizeV2} from "./gradeVideoSourceUploadV2";
afterEach(()=>vi.unstubAllGlobals());
function fixture(noContext=false) {
  const order:string[]=[],ctx={clearRect:vi.fn(()=>order.push("clear")),drawImage:vi.fn(()=>order.push("draw"))};
  const canvas={width:300,height:150,getContext:vi.fn(()=>noContext?null:ctx)};
  const createElement=vi.fn(()=>canvas);vi.stubGlobal("document",{createElement});
  const gl={TEXTURE_2D:1,RGBA:2,UNSIGNED_BYTE:3,texImage2D:vi.fn(()=>order.push("upload")),pixelStorei:vi.fn()} as unknown as WebGL2RenderingContext;
  const video={videoWidth:96,videoHeight:64,currentTime:0,src:"owned-video"} as HTMLVideoElement;
  return {order,ctx,canvas,createElement,gl,video,upload:createGradeVideoSourceUploadV2(gl)};
}
describe("bounded video texture source normalizes the DOM upload and owns its staging lifetime",()=>{
  it("reuses one surface, clears each frame and uploads that surface instead of the video fast path",()=>{
    const f=fixture(),before={...f.video};
    for(let n=0;n<3;n++)f.upload.upload(f.video);
    expect(f.createElement).toHaveBeenCalledTimes(1);expect(f.canvas.getContext).toHaveBeenCalledWith("2d",{alpha:true,colorSpace:"srgb"});
    expect(f.order).toEqual(["clear","draw","upload","clear","draw","upload","clear","draw","upload"]);
    expect(f.ctx.clearRect).toHaveBeenLastCalledWith(0,0,96,64);expect(f.ctx.drawImage).toHaveBeenLastCalledWith(f.video,0,0,96,64);
    expect(f.gl.texImage2D).toHaveBeenLastCalledWith(1,0,2,2,3,f.canvas);expect(f.gl.pixelStorei).not.toHaveBeenCalled();expect(f.video).toEqual(before);
  });
  it("resizes the same surface, releases it on close and rejects later stale draws",()=>{
    const f=fixture();f.upload.upload(f.video);Object.defineProperty(f.video,"videoWidth",{value:192});f.upload.upload(f.video);
    expect(f.canvas.width).toBe(192);expect(f.createElement).toHaveBeenCalledTimes(1);
    f.upload.dispose();expect([f.canvas.width,f.canvas.height]).toEqual([1,1]);
    expect(()=>f.upload.upload(f.video)).toThrow("GRADE_VIDEO_SOURCE_CLOSED");f.upload.dispose();expect(f.gl.texImage2D).toHaveBeenCalledTimes(2);
  });
  it.each([0,-1,1.5,NaN,Infinity,8193])("refuses width %s before allocating or uploading",width=>{
    const f=fixture();Object.defineProperty(f.video,"videoWidth",{value:width});
    expect(()=>f.upload.upload(f.video)).toThrow("GRADE_VIDEO_SOURCE_FRAME_BUDGET");expect(f.createElement).not.toHaveBeenCalled();expect(f.gl.texImage2D).not.toHaveBeenCalled();
  });
  it("admits an8K surface within128MiB and rejects larger byte counts without allocating one",()=>{
    expect(gradeVideoSourceSizeV2(7680,4320)).toBe(true);expect(gradeVideoSourceSizeV2(8192,4096)).toBe(true);
    expect(gradeVideoSourceSizeV2(8192,4097)).toBe(false);expect(gradeVideoSourceSizeV2(4096,8193)).toBe(false);
    const f=fixture();Object.defineProperties(f.video,{videoWidth:{value:8192},videoHeight:{value:4097}});
    expect(()=>f.upload.upload(f.video)).toThrow("GRADE_VIDEO_SOURCE_FRAME_BUDGET");expect(f.createElement).not.toHaveBeenCalled();
  });
  it("does not keep allocating when a2D context is unavailable",()=>{
    const f=fixture(true);for(let n=0;n<2;n++)expect(()=>f.upload.upload(f.video)).toThrow("GRADE_VIDEO_SOURCE_CONTEXT");
    expect(f.createElement).toHaveBeenCalledTimes(1);expect([f.canvas.width,f.canvas.height]).toEqual([1,1]);expect(f.gl.texImage2D).not.toHaveBeenCalled();f.upload.dispose();
  });
  it("does not replace the owned surface after an upload failure",()=>{
    const f=fixture();vi.mocked(f.gl.texImage2D).mockImplementationOnce(()=>{throw Error("context lost");});
    expect(()=>f.upload.upload(f.video)).toThrow("context lost");f.upload.upload(f.video);expect(f.createElement).toHaveBeenCalledTimes(1);f.upload.dispose();
  });
});
