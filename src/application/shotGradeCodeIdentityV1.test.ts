import {beforeAll,expect,it} from "vitest";
import {spawnSync} from "node:child_process";
import {copyFile,mkdir,readFile,writeFile,readdir,appendFile} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildShotGradeBundleV1} from "../../scripts/lib/shot-grade-bundle-identity-v1.mjs";
import {buildMaterialColorBundle} from "../../scripts/lib/material-color-bundle-identity.mjs";
import {shotGradeCodeIdentityV1} from "./shotGradeCodeIdentityV1";
import names from "./shotGradeImplementationPathsV1.json";
import primaryNames from "./materialColorImplementationPaths.json";
import {colorBytesSha} from "./materialColorSamplingRuntime";
import {REPO_TMP,useTempRoots} from "../test/tempRoot.mjs";
const app=fileURLToPath(new URL("../../",import.meta.url)),temp=useTempRoots(),tsx=join(app,"node_modules/tsx/dist/cli.mjs");
function execute(path:string,source=false){const result=spawnSync(process.execPath,source?[tsx,path]:[path],{windowsHide:true,encoding:"utf8",timeout:30000,maxBuffer:1024*1024});expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);}
const entry='import {shotGradeCodeIdentityV1} from '+JSON.stringify(join(app,"src/application/shotGradeCodeIdentityV1.ts"))+';try{console.log(JSON.stringify({identity:shotGradeCodeIdentityV1()}));}catch(e){console.log(JSON.stringify({rejected:e.message}));}';
let root:string,bundle:string,sidecar:string;
beforeAll(async()=>{root=await temp.create("shot-grade-code-",{parent:REPO_TMP});const built=await buildShotGradeBundleV1({absWorkingDir:app,stdin:{contents:entry,resolveDir:app,sourcefile:"owned-grade-identity.ts"},outfile:join(root,"built/bundle.mjs"),minify:true,legalComments:"none"});bundle=built.outfile;sidecar=built.sidecar;},60000);
it("binds every owned numerical/source/MCP input without substituting primary33 identity",()=>{
 const identity=shotGradeCodeIdentityV1();expect(identity.code.mode).toBe("source");expect(identity.primaryImplementations).toHaveLength(33);expect(identity.implementations.map(row=>row.name)).toEqual(names);
 for(const path of ["src/color/shotGradeCandidateV1.ts","src/color/shotGradeAutoBalanceV1.ts","src/color/shotGradeStatisticsV1.ts","src/color/gradeLutBake.ts","src/application/shotGradeFramesV1.ts","src/application/shotGradeRenderedFramesV1.ts","src/application/shotGradeEvidenceV1.ts","src/mcp/shotGradeToolsV1.ts"])expect(names).toContain(path);
 expect(identity.implementations).toHaveLength(327);
});
it("executes a source-free relocated bundle and binds actual executed bytes",async()=>{
 const relocated=join(root,"relocated");await mkdir(relocated);await copyFile(bundle,join(relocated,"bundle.mjs"));await copyFile(sidecar,join(relocated,"bundle.mjs.material-color-identity.json"));
 expect((await readdir(relocated)).sort()).toEqual(["bundle.mjs","bundle.mjs.material-color-identity.json"]);
 const result=execute(join(relocated,"bundle.mjs"));expect(result.rejected).toBeUndefined();expect(result.identity.code.mode).toBe("bundle");
 expect(result.identity.code.sha256).toBe(colorBytesSha(await readFile(bundle)));expect(result.identity.code.manifestSha256).toBe(colorBytesSha(await readFile(sidecar)));expect(result.identity.implementations).toHaveLength(327);
},60000);
it("refuses a valid primary-only bundle as new grade evidence",async()=>{
 const built=await buildMaterialColorBundle({absWorkingDir:app,stdin:{contents:entry,resolveDir:app},outfile:join(root,"old-only/bundle.mjs"),minify:true});
 expect(execute(built.outfile).rejected).toBe("shot-grade-instrumented-bundle-required");
},60000);
it.each(["missing-sidecar","changed-sidecar","changed-bundle"])("rejects %s without adjacent-source fallback",async mode=>{
 const folder=join(root,mode);await mkdir(folder);const file=join(folder,"bundle.mjs");await copyFile(bundle,file);
 if(mode!=="missing-sidecar")await copyFile(sidecar,file+".material-color-identity.json");
 if(mode==="changed-sidecar"){const value=JSON.parse(await readFile(sidecar,"utf8"));value.bundle.sha256="0".repeat(64);await writeFile(file+".material-color-identity.json",JSON.stringify(value));}
 if(mode==="changed-bundle")await appendFile(file,"\n// owned changed executable bytes\n");
 expect(execute(file).rejected).toBeTruthy();
});
it("refuses a changed new-grade source after initialization using an owned source copy",async()=>{
 const workspace=await temp.create("shot-grade-source-copy-",{parent:REPO_TMP}),fake=join(workspace,"apps/hao-editor");await mkdir(fake,{recursive:true});await writeFile(join(fake,"package.json"),JSON.stringify({type:"module"}));
 for(const name of names){const target=resolve(fake,name);expect(relativeInside(workspace,target)).toBe(true);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(app,name),target);}
 for(const name of primaryNames){const target=resolve(fake,"src/application",name);expect(relativeInside(workspace,target)).toBe(true);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(app,"src/application",name),target);}
 const sourceEntry=join(fake,"owned-entry.ts"),module=pathToFileURL(join(fake,"src/application/shotGradeCodeIdentityV1.ts")).href;
 const program=["import {appendFile} from 'node:fs/promises';","const {shotGradeCodeIdentityV1}=await import("+JSON.stringify(module)+");","const first=shotGradeCodeIdentityV1();",
  "await appendFile("+JSON.stringify(join(fake,"src/color/shotGradeCandidateV1.ts"))+",'\\n// owned stale grade control\\n');",
  "try{console.log(JSON.stringify({unexpected:shotGradeCodeIdentityV1()}));}catch(e){console.log(JSON.stringify({before:first.identitySha256,rejected:e.message}));}"].join("\n");
 await writeFile(sourceEntry,program);const result=execute(sourceEntry,true);expect(result.before).toMatch(/^[a-f0-9]{64}$/);expect(result.rejected).toBe("shot-grade-loaded-source-drift");
},60000);
function relativeInside(root:string,path:string){const prefix=resolve(root)+"\\";return process.platform==="win32"?path.toLowerCase().startsWith(prefix.toLowerCase()):path.startsWith(resolve(root)+"/");}
