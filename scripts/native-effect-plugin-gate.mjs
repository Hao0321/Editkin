import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const cargo=process.env.CARGO||join(homedir(),".cargo","bin",process.platform==="win32"?"cargo.exe":"cargo");
const extension=process.platform==="win32"?".exe":"";
const libraryName=process.platform==="win32"?"editkin_effect_test_plugin.dll":process.platform==="darwin"?"libeditkin_effect_test_plugin.dylib":"libeditkin_effect_test_plugin.so";
const pluginRoot=join(root,"native","effect-test-plugin");
const coreRoot=join(root,"native","hao-core");
const corePath=join(coreRoot,"target","release",`hao-core${extension}`);
const libraryPath=join(pluginRoot,"target","release",libraryName);
const evidence=resolve(root,"..","..",".rd","benchmarks","editkin-native-effect-plugin");

function run(executable,args,cwd){
  const result=spawnSync(executable,args,{cwd,encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024});
  if(result.status!==0)throw new Error(`${executable} ${args.join(" ")} failed\n${result.stderr||result.stdout}`);
  return result.stdout.trim();
}

function runAsync(executable,args,cwd){
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout=""; let stderr="";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk=>stdout+=chunk); child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>code===0?resolvePromise(stdout.trim()):reject(new Error(`worker exited ${code}: ${stderr||stdout}`)));
  });
}

run(cargo,["build","--release"],pluginRoot);
run(cargo,["build","--release"],coreRoot);
await mkdir(evidence,{recursive:true});
const librarySha256=createHash("sha256").update(await readFile(libraryPath)).digest("hex");
const manifestPath=join(evidence,"manifest.json");
const inputPath=join(evidence,"input.rgba32f");
const outputPath=join(evidence,"output.rgba32f");
const requestPath=join(evidence,"request.json");
const manifest={schema:"editkin.effect-plugin/v1",id:"editkin.diagnostic.gain-invert",version:"2.0.0",abiVersion:2,librarySha256,entrySymbol:"editkin_effect_plugin_v2",supportedFormats:["rgba32_float"],maxTemporalRadius:0,timeoutMs:3000,deterministic:true};
await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
const pixels=new Float32Array([0.2,0.1,0.05,1,0.1,0.2,0.3,0.5,0,0,0,0,0.8,0.4,0.2,1,0.3,0.2,0.1,0.8,0.4,0.4,0.4,1,0.2,0.1,0.05,0.5,0.6,0.3,0.2,1]);
await writeFile(inputPath,Buffer.from(pixels.buffer,pixels.byteOffset,pixels.byteLength));
const request={schema:"editkin.effect-plugin-run/v1",manifestPath,libraryPath,inputPath,outputPath,width:4,height:2,frameIndex:48,timeNumerator:8,timeDenominator:5,parameters:[0.8,0.25,0]};
await writeFile(requestPath,`${JSON.stringify(request,null,2)}\n`);
const supervisor=JSON.parse(run(corePath,["effect-plugin-run",requestPath],coreRoot));
const outputBuffer=await readFile(outputPath); const output=new Float32Array(outputBuffer.buffer,outputBuffer.byteOffset,outputBuffer.byteLength/4);
if(output.length!==pixels.length||![...output].every(Number.isFinite)||Math.abs(output[3]-1)>1e-6||Math.abs(output[7]-0.5)>1e-6)throw new Error("plugin output failed pixel/alpha validation");
const firstExpected=(0.2+(0.8-0.2)*0.25)*0.8;
if(Math.abs(output[0]-firstExpected)>1e-5)throw new Error(`plugin output mismatch: ${output[0]} != ${firstExpected}`);
if(supervisor.worker?.frameIndex!==48||!/^([0-9a-f]{64})$/.test(supervisor.worker?.cacheIdentity??""))throw new Error("v2 time/cache receipt is incomplete");
const badManifestPath=join(evidence,"manifest-bad-hash.json");
await writeFile(badManifestPath,`${JSON.stringify({...manifest,librarySha256:"0".repeat(64)},null,2)}\n`);
const badRequestPath=join(evidence,"request-bad-hash.json");
await writeFile(badRequestPath,`${JSON.stringify({...request,manifestPath:badManifestPath},null,2)}\n`);
const negative=spawnSync(corePath,["effect-plugin-run",badRequestPath],{cwd:coreRoot,encoding:"utf8",windowsHide:true});
if(negative.status===0||!negative.stderr.includes("hash mismatch"))throw new Error("negative control did not reject a mismatched plugin hash");

const timeoutManifestPath=join(evidence,"manifest-timeout.json");
await writeFile(timeoutManifestPath,`${JSON.stringify({...manifest,timeoutMs:100},null,2)}\n`);
async function expectFailure(name,parameters,expected,caseManifestPath=manifestPath){
  const caseOutput=join(evidence,`${name}.rgba32f`);
  const caseRequest=join(evidence,`request-${name}.json`);
  await writeFile(caseRequest,`${JSON.stringify({...request,manifestPath:caseManifestPath,outputPath:caseOutput,parameters},null,2)}\n`);
  const result=spawnSync(corePath,["effect-plugin-run",caseRequest],{cwd:coreRoot,encoding:"utf8",windowsHide:true,timeout:5000});
  if(result.status===0||!result.stderr.includes(expected))throw new Error(`${name} negative control failed: ${result.stderr||result.stdout}`);
  return {name,status:result.status,diagnostic:expected};
}
const timeoutControl=await expectFailure("timeout",[0.8,0.25,1],"timed out",timeoutManifestPath);
const crashControl=await expectFailure("crash",[0.8,0.25,2],"isolated effect worker failed");
const invalidOutputControl=await expectFailure("invalid-output",[0.8,0.25,3],"invalid RGBA32F");

const concurrentRequests=[];
for(let index=0;index<8;index++){
  const concurrentRequest=join(evidence,`request-concurrent-${index}.json`);
  await writeFile(concurrentRequest,`${JSON.stringify({...request,frameIndex:index,outputPath:join(evidence,`concurrent-${index}.rgba32f`)},null,2)}\n`);
  concurrentRequests.push(runAsync(corePath,["effect-plugin-run",concurrentRequest],coreRoot));
}
const concurrentReceipts=(await Promise.all(concurrentRequests)).map(JSON.parse);
if(concurrentReceipts.some(receipt=>receipt.status!=="GREEN"||receipt.isolated!==true))throw new Error("concurrent isolated worker stress failed");

const recoveryOutput=join(evidence,"recovery-output.rgba32f");
const recoveryRequest=join(evidence,"request-recovery.json");
await writeFile(recoveryRequest,`${JSON.stringify({...request,outputPath:recoveryOutput},null,2)}\n`);
const recovery=JSON.parse(run(corePath,["effect-plugin-run",recoveryRequest],coreRoot));
if(recovery.status!=="GREEN"||recovery.worker?.cacheIdentity!==supervisor.worker?.cacheIdentity)throw new Error("host did not recover deterministically after crash/timeout controls");

const report={schemaVersion:2,status:"GREEN",contract:"Versioned native effect ABI v1/v2 executes in short-lived isolated workers",librarySha256,isolated:supervisor.isolated===true,pixels:8,frameIndex:supervisor.worker.frameIndex,cacheIdentity:supervisor.worker.cacheIdentity,outputFirstRed:output[0],expectedFirstRed:firstExpected,negativeControls:["library-hash-mismatch-rejected",timeoutControl,crashControl,invalidOutputControl],concurrency:{workers:concurrentReceipts.length,status:"GREEN"},postCrashRecovery:recovery.status,sdkHeaders:[join(root,"native","effect-sdk","editkin_effect_plugin_v1.h"),join(root,"native","effect-sdk","editkin_effect_plugin_v2.h")],evidence:join(evidence,"report.json")};
await writeFile(report.evidence,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
