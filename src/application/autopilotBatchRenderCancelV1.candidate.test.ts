import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AutopilotBatchJobManager } from "./autopilotBatchJobs";
import { type AutopilotBatchManifest, type AutopilotBatchRuntime, readAutopilotBatchState } from "./autopilotBatchExecution";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { readProjectFile, writeProjectFileAtomic } from "./projectFiles";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"v4-render-cancel-")),projectPath=join(root,"project.editkin.json"),planPath=join(root,"plan.json");
  await writeProjectFileAtomic(projectPath,createDemoProject(),null);await writeFile(planPath,JSON.stringify({type:"rename_project",name:"Committed once"}));
  const manifest:AutopilotBatchManifest={schema:"editkin.autopilot-batch/v1",batchId:"cancel",expectedDeliverableCount:1,items:[{id:"one",projectPath,planPath,outputPath:join(root,"output.mp4")}]};
  const counts={apply:0,render:0,verify:0},receiptPath=join(root,"committed.json"),statePath=join(root,"batch.state.json");
  const runtime:AutopilotBatchRuntime={validatePaths:async()=>{},readPlan:async()=>{const text=await readFile(planPath,"utf8");return{plan:JSON.parse(text),sha256:sha(text)};},
    audit:async()=>({before:sha(await readFile(projectPath,"utf8"))}),
    apply:async(_item,plan,audit)=>{expect((audit as {before:string}).before).toBe(sha(await readFile(projectPath,"utf8")));counts.apply++;
      const before=await readProjectFile(projectPath),next=applyCommand(before,plan as Parameters<typeof applyCommand>[1]);await writeProjectFileAtomic(projectPath,next,before.revision);
      const receipt={state:"committed",projectSha256:sha(await readFile(projectPath,"utf8")),planSha256:sha(await readFile(planPath,"utf8"))};await writeFile(receiptPath,JSON.stringify(receipt));return receipt;},
    reconcile:async(_item,planSha)=>{let receipt;try{receipt=JSON.parse(await readFile(receiptPath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
      if(receipt.planSha256!==planSha||receipt.projectSha256!==sha(await readFile(projectPath,"utf8")))throw new Error("receipt binding changed");return receipt;},
    render:async(_item,path)=>{counts.render++;await writeFile(path,"controlled complete render");return{};},verifyRender:async()=>{counts.verify++;}};
  return{root,manifest,runtime,counts,statePath,projectPath};
}
it.each(["render","verify"] as const)("cancels current %s via its actual signal and resumes from the disk receipt without another apply",async phase=>{
  const f=await fixture(),entered=deferred(),manager=new AutopilotBatchJobManager({maxConcurrentJobs:1});
  const originalRender=f.runtime.render,originalVerify=f.runtime.verifyRender;
  if(phase==="render")f.runtime.render=async(_item,path,signal)=>{f.counts.render++;await writeFile(path,"partial retained candidate");expect(signal).toBeInstanceOf(AbortSignal);entered.resolve();
    return new Promise((_yes,no)=>{signal!.addEventListener("abort",()=>no(signal!.reason),{once:true});});};
  else f.runtime.verifyRender=async(_item,_path,signal)=>{f.counts.verify++;expect(signal).toBeInstanceOf(AbortSignal);entered.resolve();return new Promise((_yes,no)=>{signal!.addEventListener("abort",()=>no(signal!.reason),{once:true});});};
  const started=manager.start(f.manifest,f.statePath,f.runtime);await entered.promise;const committed=await readFile(f.projectPath,"utf8");
  expect(manager.cancel(started.jobId).status).toBe("CANCEL_REQUESTED");await vi.waitFor(()=>expect(manager.get(started.jobId).status).toBe("STOPPED"));
  const state=await readAutopilotBatchState(f.statePath,f.manifest);expect(state!.items[0].phase).toBe("rendering");expect(await lstat(state!.items[0].candidatePath!)).toBeDefined();await expect(lstat(f.manifest.items[0].outputPath)).rejects.toThrow();
  f.runtime.render=originalRender;f.runtime.verifyRender=originalVerify;
  const restarted=new AutopilotBatchJobManager({maxConcurrentJobs:1});expect((await restarted.run(f.manifest,f.statePath,f.runtime)).completed).toBe(1);
  expect(f.counts.apply).toBe(1);expect(await readFile(f.projectPath,"utf8")).toBe(committed);
});
it("does not let the new render signal cut an in-flight apply/receipt commit",async()=>{
  const f=await fixture(),entered=deferred(),held=deferred(),apply=f.runtime.apply,manager=new AutopilotBatchJobManager();
  f.runtime.apply=async(...args)=>{entered.resolve();await held.promise;return apply(...args);};
  const started=manager.start(f.manifest,f.statePath,f.runtime);await entered.promise;manager.cancel(started.jobId);held.resolve();
  await vi.waitFor(()=>expect(manager.get(started.jobId).status).toBe("STOPPED"));expect(f.counts.apply).toBe(1);expect(f.counts.render).toBe(0);
  expect((await readAutopilotBatchState(f.statePath,f.manifest))!.items[0].phase).toBe("applied");
  await new AutopilotBatchJobManager().run(f.manifest,f.statePath,f.runtime);expect(f.counts.apply).toBe(1);
});
