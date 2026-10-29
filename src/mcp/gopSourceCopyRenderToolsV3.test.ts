import{describe,expect,it,vi}from"vitest";
// Media binding has its own per-route tests (renderRouteMediaBinding.test.ts); this fixture's source is not a real file.
vi.mock("./renderMediaBinding", () => ({ bindProjectMediaForRender: async (project: unknown) => project }));
import{renderGopSourceCopyToolV3,gopSourceCopyInputSchemaV3,registerGopSourceCopyRenderToolsV3}from"./gopSourceCopyRenderToolsV3";
import{sourcePreservingFixtureV1}from"../render/sourcePreservingV1.fixture";
import type{renderGopSourceCopyProjectV3}from"../render/gopSourceCopyExportV3";
const input={projectPath:"owned.editkin.json",outputPath:"out.mp4",policy:"copy_exact_gop_postroll_original_streams_v3" as const,expectedSourceSha256:"a".repeat(64)};
function fixture(){const project=sourcePreservingFixtureV1(),release=vi.fn(async()=>undefined),render=vi.fn(async(...args:Parameters<typeof renderGopSourceCopyProjectV3>)=>{
 await args[2].withPublicationGuard!(async()=>undefined);return{outputPath:args[1]}as Awaited<ReturnType<typeof renderGopSourceCopyProjectV3>>;});
 return{project,release,render,dependencies:{readProject:vi.fn(async()=>project),resolveProjectPath:vi.fn(async()=>"D:/owned/owned.editkin.json"),resolveRenderPath:vi.fn(async()=>"D:/owned/out.mp4"),workspaceRoot:()=>"D:/owned",acquireProjectLock:vi.fn(async()=>release),render}};}
describe("separate exact packet copy source tool and current project lease",()=>{
 it("requires explicit policy/hash; extra options cannot force unsafe packet copy",()=>{
  for(const value of [{...input,policy:undefined},{...input,expectedSourceSha256:"wrong"},{...input,force:true}])expect(()=>gopSourceCopyInputSchemaV3.parse(value)).toThrow();
  const names:string[]=[];registerGopSourceCopyRenderToolsV3({registerTool:(name:string)=>names.push(name)}as never);expect(names).toEqual(["render_exact_gop_postroll_source_project"]);
 });
 it("forwards the request signal and holds/releases a project lease without modifying the project",async()=>{
  const f=fixture(),controller=new AbortController(),before=JSON.stringify(f.project),result=await renderGopSourceCopyToolV3(input,controller.signal,f.dependencies);
  expect(f.render.mock.calls[0][2].signal).toBe(controller.signal);expect(f.render.mock.calls[0][2].policy).toBe(input.policy);expect(f.release).toHaveBeenCalledOnce();expect(result.mutationPerformed).toBe(false);expect(JSON.stringify(f.project)).toBe(before);
 });
 it("revision change rejects before publication, releases the lease; preabort reads nothing",async()=>{
  const f=fixture();f.dependencies.readProject.mockResolvedValueOnce(f.project).mockResolvedValueOnce({...f.project,revision:9});
  await expect(renderGopSourceCopyToolV3(input,undefined,f.dependencies)).rejects.toThrow("PROJECT_CHANGED");expect(f.release).toHaveBeenCalledOnce();
  const aborted=fixture(),controller=new AbortController();controller.abort(Error("CONTROL_CANCEL"));await expect(renderGopSourceCopyToolV3(input,controller.signal,aborted.dependencies)).rejects.toThrow("CONTROL_CANCEL");expect(aborted.dependencies.readProject).not.toHaveBeenCalled();
 });
});
