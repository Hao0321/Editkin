import type {McpServer} from "@modelcontextprotocol/server";
import {expect,it,vi} from "vitest";
import {createDemoProject} from "../domain/demo";
import {prepareLongformModuleScheduleV1} from "../application/longformModuleScheduleV1";
import {registerLongformModuleScheduleToolsV1,LONGFORM_MODULE_SCHEDULE_TOOL_V1,LONGFORM_MODULE_SCHEDULE_RESPONSE_BYTES_V1} from "./longformModuleScheduleToolsV1";
import type {prepareLongformModuleScheduleFileV1} from "./longformModuleScheduleFileV1";
import type {LongformModuleScheduleRequestV1} from "../domain/longformModuleScheduleV1";
function fixture(){const project=createDemoProject(),request:LongformModuleScheduleRequestV1={schema:"editkin.longform-module-schedule-request/v1",expectedRevision:project.revision,
  modules:[{id:"focus-1",kind:"ui_focus",referenceId:"ug-declared",startFrame:0,endFrame:24,evidenceRefs:["source:current"]}]};
  const result=prepareLongformModuleScheduleV1(project,request),prepare=vi.fn<typeof prepareLongformModuleScheduleFileV1>(async()=>result);
  const registered=new Map<string,{config:{inputSchema:{parse:(raw:unknown)=>unknown};annotations:unknown};handler:(input:never,context:never)=>Promise<{content:Array<{text:string}>;isError?:boolean}>}>();
  const server={registerTool:vi.fn((name,config,handler)=>registered.set(name,{config,handler}))}as unknown as McpServer;registerLongformModuleScheduleToolsV1(server,prepare);
  const stop=new AbortController(),input={projectPath:"owned.editkin.json",...request};
  const call=async(raw:unknown=input)=>{const r=registered.get(LONGFORM_MODULE_SCHEDULE_TOOL_V1)!;return r.handler(r.config.inputSchema.parse(raw)as never,{mcpReq:{signal:stop.signal}}as never);};
  return{request,result,input,prepare,registered,stop,call};}
const value=(r:{content:Array<{text:string}>})=>JSON.parse(r.content[0].text);
it("registers one read-only explicit budget tool and forwards current request and cancellation",async()=>{
  const f=fixture();expect([...f.registered.keys()]).toEqual([LONGFORM_MODULE_SCHEDULE_TOOL_V1]);
  expect(f.registered.get(LONGFORM_MODULE_SCHEDULE_TOOL_V1)!.config.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
  expect(value(await f.call())).toMatchObject({status:"TIMING_BUDGET_PREPARED_NOT_APPLIED",projectModified:false,coordinatesVerified:false});
  expect(f.prepare).toHaveBeenCalledWith("owned.editkin.json",f.request,f.stop.signal);
});
it("rejects manual coordinates or old quiet/duty policy fields at the actual tool schema",async()=>{
  const f=fixture();await expect(f.call({...f.input,bounds:{x:0,y:0}})).rejects.toThrow();
  await expect(f.call({...f.input,quietFrames:120})).rejects.toThrow();await expect(f.call({...f.input,dutyRatio:.25})).rejects.toThrow();expect(f.prepare).not.toHaveBeenCalled();
});
it("reports current-source errors and bounds the transport response",async()=>{
  const f=fixture();f.prepare.mockRejectedValueOnce(Error("LONGFORM_MODULE_PROJECT_FILE_CHANGED"));const changed=await f.call();
  expect(changed.isError).toBe(true);expect(value(changed).error).toBe("LONGFORM_MODULE_PROJECT_FILE_CHANGED");
  f.prepare.mockResolvedValueOnce({...f.result,next:"x".repeat(LONGFORM_MODULE_SCHEDULE_RESPONSE_BYTES_V1)});
  const large=await f.call();expect(large.isError).toBe(true);expect(value(large).error).toBe("LONGFORM_MODULE_RESPONSE_BUDGET");expect(JSON.stringify(large).length).toBeLessThan(1000);
});
