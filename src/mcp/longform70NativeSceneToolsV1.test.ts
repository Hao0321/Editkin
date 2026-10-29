import type { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { longform70NativeFixtureV1 } from "../application/longform70NativeSceneV1.fixture";
import { LONGFORM70_CATALOG_V1 } from "../application/longform70NativeCatalogV1";
import { registerLongform70NativeSceneToolsV1, LONGFORM70_NATIVE_TOOLS_V1, LONGFORM70_NATIVE_RESPONSE_BYTES_V1 } from "./longform70NativeSceneToolsV1";
import type { prepareLongform70NativeSceneFileV1 } from "./longform70NativeSceneFileV1";

type Result=Awaited<ReturnType<typeof prepareLongform70NativeSceneFileV1>>;
function fixture(){
  const registered=new Map<string,{config:{inputSchema:{parse:(value:unknown)=>unknown};annotations:unknown;description:string};
    handler:(value:never,context:never)=>Promise<{content:Array<{text:string}>;isError?:boolean}>}>();
  const server={registerTool:vi.fn((name,config,handler)=>registered.set(name,{config,handler}))}as unknown as McpServer;
  const result:Result={schema:"editkin.longform70-native-scene-file-prepared/v1",status:"PREPARED_NOT_APPLIED",readOnly:true,
    projectRevision:0,sceneId:"fixture-number-hook",recipeId:"number-hook",designProfileSha256:LONGFORM70_CATALOG_V1.designProfileSha256,commands:[],applyAsOneBatch:true,
    graphicCount:0,graphicBindings:[],physicalLayouts:[],checks:[],artStatus:"ART_PENDING_CLAUDE",selectableByDefault:false,
    freshEvidenceState:"CALLER_DECLARED_REQUIRES_V4_MATERIAL_AUDIT",contentVerified:false,projectModified:false,next:"independent audit/apply/render"};
  const prepare=vi.fn<typeof prepareLongform70NativeSceneFileV1>(async()=>result),environment={EDITKIN_FONT_ROOT:"D:/owned-fonts"},stop=new AbortController();
  registerLongform70NativeSceneToolsV1(server,environment,prepare);
  const call=async(name:string,input:unknown)=>{const entry=registered.get(name)!;
    return entry.handler(entry.config.inputSchema.parse(input)as never,{mcpReq:{signal:stop.signal}}as never);};
  return{registered,prepare,result,environment,stop,call};
}
const value=(response:{content:Array<{text:string}>})=>JSON.parse(response.content[0].text);
it("registers only explicit list/preparation tools and keeps the catalog uncertified",async()=>{
  const f=fixture();expect([...f.registered.keys()]).toEqual([...LONGFORM70_NATIVE_TOOLS_V1]);
  const result=value(await f.call("list_longform_native_recipes",{}));expect(result.recipes).toHaveLength(8);
  expect(result.certification).toEqual({status:"ART_PENDING_CLAUDE",selectableByDefault:false});
  expect(f.registered.get("prepare_longform_native_scene")!.config.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
});
it("forwards the parsed new scene, environment and MCP cancellation signal",async()=>{
  const f=fixture(),request=longform70NativeFixtureV1("number-hook").request;
  expect(value(await f.call("prepare_longform_native_scene",{projectPath:"owned.editkin.json",...request}))).toMatchObject({status:"PREPARED_NOT_APPLIED",projectModified:false});
  expect(f.prepare).toHaveBeenCalledWith("owned.editkin.json",request,f.environment,f.stop.signal);
  await expect(f.call("prepare_longform_native_scene",{projectPath:"owned.editkin.json",...request,model:"medium"})).rejects.toThrow();
  await expect(f.call("list_longform_native_recipes",{certified:true})).rejects.toThrow();
});
it("reports file/font failures and refuses oversized payloads",async()=>{
  const f=fixture(),request={projectPath:"owned.editkin.json",...longform70NativeFixtureV1("number-hook").request};
  f.prepare.mockRejectedValueOnce(new Error("LONGFORM70_PROJECT_FILE_CHANGED"));
  const changed=await f.call("prepare_longform_native_scene",request);expect(changed.isError).toBe(true);expect(value(changed).error).toBe("LONGFORM70_PROJECT_FILE_CHANGED");
  f.prepare.mockResolvedValueOnce({...f.result,next:"x".repeat(LONGFORM70_NATIVE_RESPONSE_BYTES_V1)});
  const large=await f.call("prepare_longform_native_scene",request);expect(large.isError).toBe(true);expect(value(large).error).toBe("LONGFORM70_RESPONSE_BUDGET");
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(1000);
});
