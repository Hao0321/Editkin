import { mkdtemp, readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { withBatchExecutionOwnerV1 } from "./batchExecutionOwnerV1";
import { acquireProjectLock } from "./projectFiles";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
async function stageLockFixture(root:string){
  // The child executes the exact canonical lock function and owner source. Only unrelated project-codec
  // imports are omitted, so tiny OS-lease tests need no tsx/esbuild/helper process in their child tree.
  const testDir=dirname(fileURLToPath(import.meta.url));
  const app=globalThis.process.cwd();
  const projectFile=join(testDir,"projectFiles.ts"),ownerFile=join(testDir,"batchExecutionOwnerV1.ts");
  const sourceText=await readFile(projectFile,"utf8"),ownerText=await readFile(ownerFile,"utf8");
  const source=ts.createSourceFile(projectFile,sourceText,ts.ScriptTarget.Latest,true);
  const parts=["lockPath","ProjectLockBusyError","acquireProjectLock"].map(name=>source.statements.find(node=>(ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name?.text===name)?.getText(source));
  if(parts.some(value=>!value))throw new Error("Missing canonical lock function");
  const pathImport=source.statements.find(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==="node:path")?.getText(source);
  if(!pathImport)throw new Error("Missing canonical lock path import");
  // Retain the canonical Windows namespace helper dependency in the actual extracted lock body.
  const lockText='import {mkdir,lstat} from "node:fs/promises";\n'+pathImport+'\nimport {DatabaseSync} from "node:sqlite";\n'+parts.join("\n");
  const transpile=(text:string)=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  await writeFile(join(root,"projectLock.mjs"),transpile(lockText));
  await writeFile(join(root,"localMediaPath.mjs"),transpile(await readFile(join(app,"src/shared/localMediaPath.ts"),"utf8")));
  await writeFile(join(root,"owner.mjs"),transpile(ownerText.replace('"./projectFiles"','"./projectLock.mjs"').replace('"../shared/localMediaPath"','"./localMediaPath.mjs"')));
  const child=join(root,"child.mjs");
  await writeFile(child,'import {withBatchExecutionOwnerV1} from "./owner.mjs";\nconst [cache,operation]=process.argv.slice(2);\ntry { await withBatchExecutionOwnerV1(cache,operation,async()=>{process.stdout.write("OWNED\\n");await new Promise(done=>process.stdin.once("data",done));}); process.stdout.write("RELEASED\\n"); } catch(error) { process.stdout.write(JSON.stringify({error:error.message})+"\\n");process.exitCode=7; }\n');
  await writeFile(join(root,"fixture-source.json"),JSON.stringify({projectFile,ownerFile,projectSha256:hash(sourceText),ownerSha256:hash(ownerText),extractedFunctions:parts.map(value=>hash(value!))},null,2));
  return child;
}
function launch(child:string,cache:string,operation:string){
  const process=spawn(globalThis.process.execPath,[child,cache,operation],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  let stdout="",stderr="";let accept!:(value:void)=>void;let reject!:(error:Error)=>void;
  const ready=new Promise<void>((yes,no)=>{accept=yes;reject=no;});
  const timer=setTimeout(()=>reject(new Error("Owned child readiness timeout")),3000);
  process.stdout.on("data",chunk=>{stdout+=chunk.toString();if(stdout.includes("OWNED\n")){clearTimeout(timer);accept();}});
  process.stderr.on("data",chunk=>{stderr+=chunk.toString();});
  const exited=new Promise<number|null>((yes,no)=>{process.once("error",no);process.once("close",code=>{clearTimeout(timer);if(!stdout.includes("OWNED\n"))reject(new Error(stdout||stderr));yes(code);});});
  // A denied child intentionally never becomes ready; consume its rejection until the caller inspects exit.
  void ready.catch(()=>undefined);
  return{process,ready,exited,logs:()=>({stdout,stderr})};
}

describe("existing OS lock as the shared batch admission owner",()=>{
  it("keeps same-operation requests out before executing another body",async()=>{
    const root=await mkdtemp(join(tmpdir(),"batch-owner-op-"));let release!:()=>void;const held=new Promise<void>(done=>{release=done;});let entered!:()=>void;const ready=new Promise<void>(done=>{entered=done;});
    const first=withBatchExecutionOwnerV1(root,join(root,"project.json"),async()=>{entered();await held;});await ready;
    let duplicate=false;try{await expect(withBatchExecutionOwnerV1(root,join(root,"project.json"),async()=>{duplicate=true;})).rejects.toThrow("ALREADY_RUNNING");}
    finally{release();await first;}expect(duplicate).toBe(false);
  });
  it("a fail-fast lock attempt never expires or steals a held owner",async()=>{
    const root=await mkdtemp(join(tmpdir(),"batch-lock-try-")),path=join(root,"guard");const release=await acquireProjectLock(path);
    try{await expect(acquireProjectLock(path,{maximumAttempts:1})).rejects.toMatchObject({name:"ProjectLockBusyError"});}
    finally{await release();}const resumed=await acquireProjectLock(path,{maximumAttempts:1});await resumed();
  });
  it("refuses an alias root before running a job",async()=>{
    const root=await mkdtemp(join(tmpdir(),"batch-owner-alias-")),target=join(root,"target"),alias=join(root,"alias");await mkdir(target);await symlink(target,alias,globalThis.process.platform==="win32"?"junction":"dir");
    let entered=false;await expect(withBatchExecutionOwnerV1(alias,join(root,"project"),async()=>{entered=true;})).rejects.toThrow("LINK_REFUSED");expect(entered).toBe(false);
  });
  it("four real Node owners reject a fifth, and process exit releases the existing OS lease",async()=>{
    const root=await mkdtemp(join(tmpdir(),"batch-owner-process-")),child=await stageLockFixture(root),cache=join(root,"cache");const owners=[] as Array<ReturnType<typeof launch>>;
    try{
      for(let index=0;index<4;index++){const owner=launch(child,cache,join(root,`operation-${index}`));owners.push(owner);await owner.ready;}
      const denied=launch(child,cache,join(root,"fifth"));expect(await denied.exited).toBe(7);expect(denied.logs().stdout).toContain("CAPACITY_REACHED");
      const duplicate=launch(child,cache,join(root,"operation-0"));expect(await duplicate.exited).toBe(7);expect(duplicate.logs().stdout).toContain("ALREADY_RUNNING");
      owners[0].process.kill();await owners[0].exited;
      const resumed=launch(child,cache,join(root,"operation-0"));owners.push(resumed);await resumed.ready;resumed.process.stdin.end("release\n");expect(await resumed.exited).toBe(0);
      if(globalThis.process.env.AUTOEDIT_EVIDENCE_PREFIX)await writeFile(globalThis.process.env.AUTOEDIT_EVIDENCE_PREFIX+".cross-process.json",JSON.stringify({maximumOwners:4,deniedFifth:true,deniedDuplicate:true,restartedAfterProcessExit:true,childRuntime:globalThis.process.execPath,logs:owners.map(owner=>owner.logs())},null,2));
    }finally{for(const owner of owners){if(owner.process.exitCode===null&&!owner.process.killed)owner.process.stdin.end("release\n");await owner.exited;}}
  });
});
