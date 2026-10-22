import{describe,expect,it,vi}from"vitest";
import{renderGopSourceCopyToolV2,gopSourceCopyInputSchemaV2,registerGopSourceCopyRenderToolsV2}from"./gopSourceCopyRenderToolsV2";
import{sourcePreservingFixtureV1}from"../render/sourcePreservingV1.fixture";
import type{renderGopSourceCopyProjectV2}from"../render/gopSourceCopyExportV2";
const input={projectPath:"owned.editkin.json",outputPath:"out.mp4",policy:"copy_exact_gop_original_streams_v2" as const,expectedSourceSha256:"a".repeat(64)};
function fixture(){const project=sourcePreservingFixtureV1(),release=vi.fn(async()=>undefined),render=vi.fn(async(...args:Parameters<typeof renderGopSourceCopyProjectV2>)=>{
 await args[2].withPublicationGuard!(async()=>undefined);return{outputPath:args[1]}as Awaited<ReturnType<typeof renderGopSourceCopyProjectV2>>;});
 return{project,release,render,dependencies:{readProject:vi.fn(async()=>project),resolveProjectPath:vi.fn(async()=>"D:/owned/owned.editkin.json"),resolveRenderPath:vi.fn(async()=>"D:/owned/out.mp4"),workspaceRoot:()=>"D:/owned",acquireProjectLock:vi.fn(async()=>release),render}};}
describe("separate exact packet copy source tool and current project lease",()=>{
 it("requires explicit policy/hash; extra options cannot force unsafe packet copy",()=>{
  for(const value of [{...input,policy:undefined},{...input,expectedSourceSha256:"wrong"},{...input,force:true}])expect(()=>gopSourceCopyInputSchemaV2.parse(value)).toThrow();
  const names:string[]=[];registerGopSourceCopyRenderToolsV2({registerTool:(name:string)=>names.push(name)}as never);expect(names).toEqual(["render_exact_gop_source_project"]);
 });
 it("forwards the request signal and holds/releases a project lease without modifying the project",async()=>{
  const f=fixture(),controller=new AbortController(),before=JSON.stringify(f.project),result=await renderGopSourceCopyToolV2(input,controller.signal,f.dependencies);
  expect(f.render.mock.calls[0][2].signal).toBe(controller.signal);expect(f.render.mock.calls[0][2].policy).toBe(input.policy);expect(f.release).toHaveBeenCalledOnce();expect(result.mutationPerformed).toBe(false);expect(JSON.stringify(f.project)).toBe(before);
 });
 it("revision change rejects before publication, releases the lease; preabort reads nothing",async()=>{
  const f=fixture();f.dependencies.readProject.mockResolvedValueOnce(f.project).mockResolvedValueOnce({...f.project,revision:9});
  await expect(renderGopSourceCopyToolV2(input,undefined,f.dependencies)).rejects.toThrow("PROJECT_CHANGED");expect(f.release).toHaveBeenCalledOnce();
  const aborted=fixture(),controller=new AbortController();controller.abort(Error("CONTROL_CANCEL"));await expect(renderGopSourceCopyToolV2(input,controller.signal,aborted.dependencies)).rejects.toThrow("CONTROL_CANCEL");expect(aborted.dependencies.readProject).not.toHaveBeenCalled();
 });
});
