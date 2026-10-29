import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerFinalOutputScopeToolsV1 } from "./finalOutputScopesToolsV1";
import { measureFinalPixelScopesV1 } from "../color/finalPixelScopesV1";
const artifact={schema:"editkin.render-artifact-identity/v1",outputSha256:"a".repeat(64),bytes:3,fps:30,durationFrames:2,projectContentSha256:"b".repeat(64)};
const input={outputPath:"final.mp4",artifact,timelineFrame:1,page:{scope:"histogram",plane:"red",offset:0,limit:16}};
function fixture(){
  const registerTool=vi.fn(),resolveOutputPath=vi.fn(async()=>"D:/owned/final.mp4"),measure=vi.fn(async(_request:unknown,_runtime:unknown)=>({measurement:measureFinalPixelScopesV1({width:1,height:1,format:"rgb8",pixels:new Uint8Array([255,0,0]),primaries:"bt709",transfer:"bt709",range:"full"},{histogramBins:16}),receipt:{}} as never));
  registerFinalOutputScopeToolsV1({registerTool} as unknown as McpServer,{resolveOutputPath,measure,runtime:()=>({ffmpegPath:"D:/ffmpeg.exe",timeoutMs:30000})});
  const [name,config,handler]=registerTool.mock.calls[0],signal=new AbortController().signal;
  return{name,config,handler:(request:unknown)=>handler(request,{mcpReq:{signal}}),resolveOutputPath,measure,signal};
}
describe("read-only final output colour scope MCP",()=>{
  it("registers bounded read-only annotations and forwards actual output expectations/cancellation",async()=>{
    const f=fixture(),result=await f.handler(input),payload=JSON.parse(result.content[0].text);
    expect(f.name).toBe("measure_final_output_color_scopes");expect(f.config.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    expect(payload.page.values[15]).toBe(1);expect(payload.scopes.pixelCount).toBe(1);expect(f.measure.mock.calls[0][1]).toMatchObject({signal:f.signal});
    expect(f.resolveOutputPath).toHaveBeenCalledWith("final.mp4");expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(16384);
  });
  it.each([{page:{scope:"vectorscope",plane:"red",offset:0,limit:1}},{page:{scope:"histogram",plane:"red",offset:0,limit:257}},{timelineFrame:2},{overwrite:true},
    {artifact:{...artifact,projectContentSha256:"short"}},{options:{nativeApproximate:true}}])("rejects invalid untyped input before file lookup %j",async patch=>{
    const f=fixture(),result=await f.handler({...input,...patch});expect(result.isError).toBe(true);expect(f.resolveOutputPath).not.toHaveBeenCalled();expect(f.measure).not.toHaveBeenCalled();
  });
  it("propagates actual output identity refusal without modifying the project",async()=>{
    const f=fixture();f.measure.mockRejectedValue(new Error("output bytes do not match expected artifact"));
    expect(JSON.parse((await f.handler(input)).content[0].text)).toMatchObject({status:"BLOCK",error:"output bytes do not match expected artifact"});
  });
});
