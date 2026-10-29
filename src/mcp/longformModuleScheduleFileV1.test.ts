import {mkdtemp,readFile,writeFile,unlink,rmdir,lstat} from "node:fs/promises";
import {resolve,join,sep} from "node:path";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {createDemoProject} from "../domain/demo";
import {encodeProjectBytes} from "../application/projectCodec";
import {prepareLongformModuleScheduleFileV1} from "./longformModuleScheduleFileV1";
import * as storage from "./storage";
import type {LongformModuleScheduleRequestV1} from "../domain/longformModuleScheduleV1";
const base=resolve(process.cwd(),".rd/benchmarks/usable-v1-20261009/work/codex-long-3");let root:string,path:string;
const project=createDemoProject(),request:LongformModuleScheduleRequestV1={schema:"editkin.longform-module-schedule-request/v1",expectedRevision:project.revision,
  modules:[{id:"focus-1",kind:"ui_focus",referenceId:"ug-current-declared",startFrame:0,endFrame:24,evidenceRefs:["source:current"]}]};
beforeEach(async()=>{root=await mkdtemp(join(base,"module-schedule-test-"));path=join(root,"owned.editkin.json");vi.stubEnv("EDITKIN_WORKSPACE",root);await writeFile(path,encodeProjectBytes(project),{flag:"wx"});});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();if(!root.startsWith(base+sep)||!(await lstat(root)).isDirectory()||(await lstat(root)).isSymbolicLink())throw Error("Unexpected owned test directory");
  try{await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}await rmdir(root);});
it("uses the real current project file and preserves its exact bytes",async()=>{
  const before=await readFile(path),result=await prepareLongformModuleScheduleFileV1(path,request);
  expect(result.counts.ui_focus).toBe(1);expect(result.projectCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.projectModified).toBe(false);
  expect(await readFile(path)).toEqual(before);
});
it("rejects a real file mutation after first read",async()=>{
  const actual=storage.readProject;let count=0;vi.spyOn(storage,"readProject").mockImplementation(async p=>{
    const row=await actual(p);if(++count===1)await writeFile(path,encodeProjectBytes({...row,name:"changed-during-budget"}));return row;});
  await expect(prepareLongformModuleScheduleFileV1(path,request)).rejects.toThrow("PROJECT_FILE_CHANGED");expect(count).toBe(2);
});
it("retains current revision, canonical workspace and project-extension boundaries",async()=>{
  const before=await readFile(path);
  await expect(prepareLongformModuleScheduleFileV1(path,{...request,expectedRevision:100})).rejects.toThrow("REVISION");
  await expect(prepareLongformModuleScheduleFileV1(resolve(root,"../outside.editkin.json"),request)).rejects.toThrow("超出");
  await expect(prepareLongformModuleScheduleFileV1(join(root,"wrong.json"),request)).rejects.toThrow("副檔名");expect(await readFile(path)).toEqual(before);
});
it("does no file read for a pre-cancelled request and rejects cancellation during the current re-read",async()=>{
  const before=await readFile(path),stop=new AbortController();stop.abort();const read=vi.spyOn(storage,"readProject");
  await expect(prepareLongformModuleScheduleFileV1(path,request,stop.signal)).rejects.toMatchObject({name:"AbortError"});expect(read).not.toHaveBeenCalled();
  read.mockRestore();const next=new AbortController(),actual=storage.readProject;let count=0;
  vi.spyOn(storage,"readProject").mockImplementation(async p=>{const row=await actual(p);if(++count===2)next.abort();return row;});
  await expect(prepareLongformModuleScheduleFileV1(path,request,next.signal)).rejects.toMatchObject({name:"AbortError"});expect(await readFile(path)).toEqual(before);
});
