import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batchArtifactPaths, runBatchAutoEditItem, type BatchAutoEditRuntime } from "./batchAutoEdit";
import { writeProjectFileAtomic } from "./projectFiles";

const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"batch-resume-control-")),source=join(root,"source.mp4");await writeFile(source,"owned source A");
  const request={jobId:"job-resume",sourcePath:source,outputRoot:root,addMusic:false,analysisMode:"smart_cut" as const};
  const runtime:BatchAutoEditRuntime={ffmpegPath:join(root,"ffmpeg.exe"),ffprobePath:join(root,"ffprobe.exe"),modelRoot:join(root,"models"),cacheRoot:join(root,"cache")};
  const counts={project:0,analyze:0,render:0};
  const dependencies={
    inspect:async()=>({duration:6,width:1920,height:1080,hasVideo:true,hasAudio:true}),
    smartCut:async()=>{counts.analyze++;return{fps:30,sourceFrames:180,ranges:[{startFrame:0,endFrame:60},{startFrame:90,endFrame:180}],removedFrames:30,cutCount:1,silenceCount:1,thresholdDb:-35,analyzedSeconds:6,engine:"fixture",cacheHit:false};},
    writeProject:async(...args:Parameters<typeof writeProjectFileAtomic>)=>{counts.project++;return writeProjectFileAtomic(...args);},
    render:async({outputPath,options}:Parameters<typeof import("./exportVideo").exportVideo>[0])=>{
      counts.render++;options?.signal?.throwIfAborted();await writeFile(outputPath,"complete controlled render");return{outputPath,duration:5,encoder:"libx264" as const,planner:"fixture",ffmpegVersion:"fixture"};
    },
  };
  const paths=batchArtifactPaths(request);
  const run=(input=request,host=runtime)=>runBatchAutoEditItem(input,host,{...dependencies,smartCut:dependencies.smartCut as never});
  const receipt=async()=>JSON.parse(await readFile(paths.receiptPath,"utf8"));
  return{root,source,request,runtime,dependencies,counts,paths,run,receipt};
}
describe("legacy batch canonical origin and cancellable render resume",()=>{
  it("two native picker sessions with the same job/source/root keep independent project/output identities",async()=>{
    const f=await fixture(),first={...f.request,sessionId:"batch-first"},second={...f.request,sessionId:"batch-second"};
    const left=await f.run(first),right=await f.run(second);expect(left.status).toBe("completed");expect(right.status).toBe("completed");
    expect(left.projectPath).not.toBe(right.projectPath);expect(left.outputPath).not.toBe(right.outputPath);expect(f.counts.project).toBe(2);
    expect(left.project?.id).not.toBe(right.project?.id);
    expect((await f.run(first)).projectPath).toBe(left.projectPath);expect(f.counts.project).toBe(2);expect(f.counts.render).toBe(2);
  });
  it("an asynchronous observer rejection cannot turn one committed batch into an unhandled failure",async()=>{
    const f=await fixture();f.runtime.onProgress=async()=>{throw new Error("observer unavailable");};
    expect((await f.run()).status).toBe("completed");expect(f.counts.project).toBe(1);expect((await f.run()).status).toBe("completed");expect(f.counts.project).toBe(1);
  });
  it("cancels a partial render, keeps its candidate, and resumes the same committed graph without rebuilding",async()=>{
    const f=await fixture(),controller=new AbortController();f.runtime.signal=controller.signal;
    f.dependencies.render=async({outputPath,options})=>{f.counts.render++;await writeFile(outputPath,"partial candidate");controller.abort(new Error("controlled-render-cancel"));options?.signal?.throwIfAborted();throw new Error("unreachable");};
    const failed=await f.run();expect(failed.status).toBe("failed");expect(failed.error).toContain("controlled-render-cancel");
    const first=await f.receipt(),project=await readFile(f.paths.projectPath,"utf8"),candidate=first.execution.candidatePath;
    expect(first).toMatchObject({status:"CANCELLED",execution:{phase:"rendering"}});expect(await readFile(candidate,"utf8")).toBe("partial candidate");
    await expect(lstat(f.paths.outputPath)).rejects.toThrow();
    f.dependencies.render=async({outputPath})=>{f.counts.render++;await writeFile(outputPath,"resumed candidate");return{outputPath,duration:5,encoder:"libx264",planner:"fixture",ffmpegVersion:"fixture"};};
    const resumed=await f.run(f.request,{...f.runtime,signal:undefined});expect(resumed.status).toBe("completed");
    expect(f.counts).toEqual({project:1,analyze:1,render:2});expect(await readFile(f.paths.projectPath,"utf8")).toBe(project);
    expect(await readFile(candidate,"utf8")).toBe("partial candidate");expect((await f.receipt()).execution.candidatePath).not.toBe(candidate);
    await f.run(f.request,{...f.runtime,signal:undefined});expect(f.counts.render).toBe(2);expect(f.counts.project).toBe(1);
  });
  it("an abort inside the canonical writer finishes the origin receipt before stopping render",async()=>{
    const f=await fixture(),controller=new AbortController();f.runtime.signal=controller.signal;
    f.dependencies.writeProject=async(...args)=>{f.counts.project++;const saved=await writeProjectFileAtomic(...args);controller.abort(new Error("during-commit"));return saved;};
    expect((await f.run()).status).toBe("failed");expect(f.counts.render).toBe(0);
    expect(await lstat(`${f.paths.projectPath}.batch-origin.json`)).toBeDefined();expect((await f.receipt()).execution.phase).toBe("applied");
    expect((await f.run(f.request,{...f.runtime,signal:undefined})).status).toBe("completed");expect(f.counts.project).toBe(1);
  });
  it("a cancellation at the apply notification performs no project write",async()=>{
    const f=await fixture(),controller=new AbortController();f.runtime.signal=controller.signal;
    f.runtime.onProgress=p=>{if(p.stage==="apply")controller.abort(new Error("before-commit"));};
    expect((await f.run()).status).toBe("failed");expect(f.counts.project).toBe(0);expect(f.counts.render).toBe(0);await expect(lstat(f.paths.projectPath)).rejects.toThrow();
  });
  it("reconciles a persisted canonical origin when the applied-phase response/journal update was lost",async()=>{
    const f=await fixture();f.dependencies.render=async()=>{throw new Error("lost renderer connection");};await f.run();
    const value=await f.receipt();value.execution.phase="applying";delete value.execution.projectSha256;await writeFile(f.paths.receiptPath,JSON.stringify(value));
    f.dependencies.render=async({outputPath})=>{f.counts.render++;await writeFile(outputPath,"recovered");return{outputPath,duration:5,encoder:"libx264",planner:"fixture",ffmpegVersion:"fixture"};};
    expect((await f.run()).status).toBe("completed");expect(f.counts.project).toBe(1);expect(f.counts.analyze).toBe(1);
  });
  it("does not guess an uncertain write succeeded when its canonical origin was never committed",async()=>{
    const f=await fixture();f.dependencies.writeProject=async(...args)=>{f.counts.project++;await writeProjectFileAtomic(...args);throw new Error("writer response lost before origin");};
    await f.run();const bytes=await readFile(f.paths.projectPath,"utf8");
    const retried=await f.run();expect(retried.error).toContain("COMMIT_UNCERTAIN");expect(f.counts.project).toBe(1);expect(await readFile(f.paths.projectPath,"utf8")).toBe(bytes);
  });
  it.each(["source","request","project"] as const)("rejects changed %s on resume while preserving the committed graph",async kind=>{
    const f=await fixture();f.dependencies.render=async()=>{throw new Error("controlled render failure");};await f.run();
    const original=await readFile(f.paths.projectPath,"utf8"),beforeReceipt=await readFile(f.paths.receiptPath,"utf8");
    if(kind==="source")await writeFile(f.source,"owned source B");
    if(kind==="project"){const project=JSON.parse(original);project.name="Human changed name";await writeFile(f.paths.projectPath,JSON.stringify(project));}
    const changed=kind==="request"?{...f.request,targetRatio:.5}:f.request;
    expect((await f.run(changed)).status).toBe("failed");expect(f.counts.project).toBe(1);expect(f.counts.analyze).toBe(1);
    if(kind!=="project")expect(await readFile(f.paths.projectPath,"utf8")).toBe(original);
    else expect(JSON.parse(await readFile(f.paths.projectPath,"utf8")).name).toBe("Human changed name");
    expect(await readFile(f.paths.receiptPath,"utf8")).toBe(beforeReceipt);
  });
  it("never replaces an existing unowned output or project",async()=>{
    const f=await fixture();await mkdir(f.paths.directory,{recursive:true});await writeFile(f.paths.outputPath,"author output");await writeFile(f.paths.projectPath,"author project");
    expect((await f.run()).status).toBe("failed");expect(f.counts).toEqual({project:0,analyze:0,render:0});
    expect(await readFile(f.paths.outputPath,"utf8")).toBe("author output");expect(await readFile(f.paths.projectPath,"utf8")).toBe("author project");
  });
  it("rejects completed output tampering rather than rendering or applying again",async()=>{
    const f=await fixture();expect((await f.run()).status).toBe("completed");await writeFile(f.paths.outputPath,"human replaced output");
    expect((await f.run()).status).toBe("failed");expect(f.counts).toEqual({project:1,analyze:1,render:1});expect(await readFile(f.paths.outputPath,"utf8")).toBe("human replaced output");
  });
  it("refuses a forged outside candidate even with matching bytes",async()=>{
    const f=await fixture();f.dependencies.render=async()=>{throw new Error("keep applied");};await f.run();
    const outside=join(f.root,"outside.mp4");await writeFile(outside,"outside");const value=await f.receipt();value.execution.candidatePath=outside;value.execution.candidateSha256=sha("outside");await writeFile(f.paths.receiptPath,JSON.stringify(value));
    expect((await f.run()).error).toContain("CANDIDATE_NOT_OWNED");expect(await readFile(outside,"utf8")).toBe("outside");expect(f.counts.project).toBe(1);
  });
});
