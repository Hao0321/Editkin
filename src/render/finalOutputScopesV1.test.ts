import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { measureFinalOutputScopesV1, type FinalOutputScopesDependencies, type FinalOutputScopesRequestV1 } from "./finalOutputScopesV1";
import { readFinalPixelScopePageV1 } from "../color/finalPixelScopesV1";
const outputPath=resolve(".rd/final-scopes-unit/output.mp4"),ffmpegPath=resolve(".rd/final-scopes-unit/ffmpeg.exe"),ffprobePath=resolve(".rd/final-scopes-unit/ffprobe.exe");
const artifact={schema:"editkin.render-artifact-identity/v1" as const,outputSha256:"a".repeat(64),bytes:8,fps:30,durationFrames:30,projectContentSha256:"b".repeat(64)};
const request:FinalOutputScopesRequestV1={outputPath,artifact,timelineFrame:7,options:{histogramBins:16,waveformLevels:16,vectorscopeBins:16}};
const runtime={ffmpegPath,ffprobePath,timeoutMs:30000};
function fixture(streamPatch:Record<string,unknown>={}, decodePatch:{stdout?:Buffer;stderr?:string}={}){
  const stream={width:1,height:1,avg_frame_rate:"30/1",r_frame_rate:"30/1",nb_frames:"30",start_time:"0.000000",
    color_primaries:"bt709",color_transfer:"bt709",color_space:"bt709",color_range:"tv",pix_fmt:"yuv420p",sample_aspect_ratio:"1:1",field_order:"progressive",...streamPatch};
  const bytes=Buffer.alloc(8);bytes.writeUInt16LE(65535,0);bytes.writeUInt16LE(65535,6);
  const hashFile=vi.fn(async(path:string)=>({sha256:path===outputPath?artifact.outputSha256:path===ffmpegPath?"c".repeat(64):"d".repeat(64),bytes:8}));
  const run=vi.fn(async(path:string)=>path===ffprobePath?{stdout:Buffer.from(JSON.stringify({streams:[stream]})),stderr:""}
    :{stdout:bytes,stderr:"config in time_base: 1/30\nn: 0 pts: 7 pts_time:0.233333 fmt:rgba64le s:1x1",...decodePatch});
  const dependencies:FinalOutputScopesDependencies={hashFile,run};return{dependencies,hashFile,run};
}
describe("bound decoded final output scopes",()=>{
  it("uses real output clock, explicit limited/full conversion and 16-bit pixels",async()=>{
    const f=fixture(),measured=await measureFinalOutputScopesV1(request,runtime,f.dependencies);
    expect(measured.receipt).toMatchObject({origin:"decoded-encoded-output",timelineFrame:7,decodedPts:7,timeBase:{numerator:1,denominator:30},decodedOutputTime:7/30,rawFormat:"rgba64le",artifact});
    expect(measured.receipt.filters).toContain("scale=in_range=limited:out_range=full:in_color_matrix=bt709");
    expect(f.hashFile).toHaveBeenCalledTimes(6);expect(f.run).toHaveBeenCalledTimes(2);
    expect(readFinalPixelScopePageV1(measured.measurement,{scope:"histogram",plane:"red",offset:0,limit:16}).values[15]).toBe(1);
    const decode=f.run.mock.calls[1];expect(decode[0]).toBe(ffmpegPath);
  });
  it("uses full input range only when the actual output tags declare it",async()=>{
    const f=fixture({color_range:"pc"});expect((await measureFinalOutputScopesV1(request,runtime,f.dependencies)).receipt.filters).toContain("scale=in_range=full:out_range=full:in_color_matrix=bt709");
  });
  it("refuses unexpected bytes before any decoder process",async()=>{
    const f=fixture();f.hashFile.mockResolvedValue({sha256:"0".repeat(64),bytes:8});
    await expect(measureFinalOutputScopesV1(request,runtime,f.dependencies)).rejects.toThrow("expected artifact");expect(f.run).not.toHaveBeenCalled();
  });
  it.each([{color_transfer:"arib-std-b67",color_primaries:"bt2020",color_space:"bt2020nc"},{color_transfer:"smpte2084"},{color_space:"gbr"},{color_range:"unknown"},{width:8193},{width:4096,height:4096},
    {sample_aspect_ratio:"2:1"},{field_order:"tt"},{side_data_list:[{rotation:90}]},{avg_frame_rate:"24/1"},{r_frame_rate:"60/1"},{nb_frames:"29"},{start_time:"N/A"}])("refuses unsupported actual probe %j",async patch=>{
    const f=fixture(patch);await expect(measureFinalOutputScopesV1(request,runtime,f.dependencies)).rejects.toThrow();expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each([{stderr:"config in time_base: 1/30\nn: 0 pts: 8 pts_time:0.266667 fmt:rgba64le s:1x1"},{stderr:"config in time_base: 1/30\nn: 0 pts: 7 pts_time:0.233333 fmt:rgba64le s:2x1"},
    {stderr:"no showinfo"},{stdout:Buffer.alloc(7)}])("refuses wrong selected output readback %j",async patch=>{
    const f=fixture({},patch);await expect(measureFinalOutputScopesV1(request,runtime,f.dependencies)).rejects.toThrow();
  });
  it("checks both output and decoder hashes again after measuring",async()=>{
    const f=fixture(),base=f.hashFile.getMockImplementation()!,counts=new Map<string,number>();
    f.hashFile.mockImplementation(async path=>{const count=(counts.get(path)??0)+1;counts.set(path,count);return path===ffmpegPath&&count===2?{sha256:"f".repeat(64),bytes:8}:base(path);});
    await expect(measureFinalOutputScopesV1(request,runtime,f.dependencies)).rejects.toThrow("identity changed");
  });
  it("binds container timeline origin without rounding to a neighbouring frame",async()=>{
    const f=fixture({start_time:"1.000000"},{stderr:"config in time_base: 1/30\nn: 0 pts: 37 pts_time:1.233333 fmt:rgba64le s:1x1"});
    expect((await measureFinalOutputScopesV1(request,runtime,f.dependencies)).receipt.decodedOutputTime).toBeCloseTo(7/30,14);
  });
  it("refuses stale/deadline/aborted requests without a child",async()=>{
    for(const patch of [{timelineFrame:30},{timelineFrame:-1},{artifact:{...artifact,outputSha256:"not-a-hash"}},{overwrite:true}]){
      const f=fixture();await expect(measureFinalOutputScopesV1({...request,...patch} as FinalOutputScopesRequestV1,runtime,f.dependencies)).rejects.toThrow();expect(f.run).not.toHaveBeenCalled();
    }
    const f=fixture();await expect(measureFinalOutputScopesV1(request,{...runtime,timeoutMs:30001},f.dependencies)).rejects.toThrow("deadline");expect(f.hashFile).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();await expect(measureFinalOutputScopesV1(request,{...runtime,signal:controller.signal},f.dependencies)).rejects.toThrow();expect(f.hashFile).not.toHaveBeenCalled();
  });
});
