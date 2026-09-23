import {beforeAll,expect,it} from "vitest";
import {build} from "esbuild";
import {spawnSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,writeFile,readdir,copyFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {pathToFileURL} from "node:url";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {buildMaterialColorBundle} from "../../scripts/lib/material-color-bundle-identity.mjs";
import {createEmptyProject} from "../domain/editGraph";
import {DEFAULT_COLOR,DEFAULT_TRANSFORM} from "../domain/types";
import {colorBytesSha,getMaterialColorRuntimeIdentity} from "./materialColorSamplingRuntime";
import {verifyMaterialColorReceipt} from "./materialColorSamplingValidation";
const app=fileURLToPath(new URL("../../",import.meta.url)),runtime={ffmpegPath:resolve(app,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),ffprobePath:resolve(app,"vendor/ffmpeg/win32-x64/ffprobe.exe")};
let dir:string,bundle:string,sidecar:string,requestFile:string;let request:Record<string,unknown>;
const entry=`import {readFile} from 'node:fs/promises';import {sampleMaterialColor} from './src/application/materialColorSampling.ts';const args=JSON.parse(await readFile(process.argv[2],'utf8'));console.log(JSON.stringify(await sampleMaterialColor(args.request,args.runtime)));`;
function execute(path:string){const child=spawnSync(process.execPath,[path,requestFile],{cwd:dir,encoding:"utf8",timeout:60000,maxBuffer:1024*1024});expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);return JSON.parse(child.stdout);}
beforeAll(async()=>{
  await mkdir(resolve(app,".rd/tmp"),{recursive:true});dir=await mkdtemp(resolve(app,".rd/tmp/color-bundle-"));
  const source=join(dir,"tagged sdr.mp4");const ff=spawnSync(runtime.ffmpegPath,["-v","error","-f","lavfi","-i","testsrc2=s=64x96:r=10:d=2","-c:v","libx264","-qp","0","-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",source],{windowsHide:true,timeout:30000});expect(ff.status,ff.stderr.toString()).toBe(0);
  request={sourcePath:source,sourceSha256:colorBytesSha(await readFile(source)),sourceStart:.1,duration:1,kind:"video",sceneCount:1,sceneCountVerified:true,sceneCuts:[],samples:[{id:"a",time:.01,sceneIndex:0}]};
  requestFile=join(dir,"request.json");await writeFile(requestFile,JSON.stringify({request,runtime}));
  const result=await buildMaterialColorBundle({absWorkingDir:app,stdin:{contents:entry,resolveDir:app,sourcefile:"bounded-color.ts"},outfile:join(dir,"valid/bundle.mjs"),minify:true,legalComments:"none"});bundle=result.outfile;sidecar=result.sidecar;
},60000);
it("executes a relocated source-free bundle and binds actual executable bytes",async()=>{
  expect((await readdir(join(dir,"valid"))).sort()).toEqual(["bundle.mjs","bundle.mjs.material-color-identity.json"]);
  const receipt=execute(bundle);await writeFile(join(dir,"positive-receipt.json"),JSON.stringify(receipt,null,2));
  expect(receipt.status,JSON.stringify(receipt)).toBe("measured");verifyMaterialColorReceipt(receipt);
  expect(receipt.identity.code).toEqual({mode:"bundle",entry:"bundle.mjs",size:(await readFile(bundle)).length,sha256:colorBytesSha(await readFile(bundle)),manifestSha256:colorBytesSha(await readFile(sidecar))});
  expect(receipt.mapping[0].decodedSourceTime).toBe(.2);expect(receipt.source.sha256).toBe(request.sourceSha256);
},60000);
it.each(["missing","malformed","hash","embedded","unknown","traversal","bundle"])("rejects %s bundle identity via actual sampler child",async mode=>{
  const target=join(dir,mode);await mkdir(target);const file=join(target,"bundle.mjs"),manifest=JSON.parse(await readFile(sidecar,"utf8"));await copyFile(bundle,file);
  if(mode==="hash")manifest.bundle.sha256="0".repeat(64);
  if(mode==="embedded")manifest.implementations[0].sha256="0".repeat(64);
  if(mode==="unknown")manifest.extra="ignored-no-longer";
  if(mode==="traversal")manifest.bundle.file="../bundle.mjs";
  if(mode==="bundle")await writeFile(file,(await readFile(file,"utf8"))+"\n// changed actual executable bytes\n");
  if(mode!=="missing")await writeFile(`${file}.material-color-identity.json`,mode==="malformed"?"{":JSON.stringify(manifest));
  const receipt=execute(file);await writeFile(join(target,"receipt.json"),JSON.stringify(receipt,null,2));expect(receipt.status).toBe("unmeasured");expect(receipt.identity.status).toBe("unmeasured");expect(receipt.measurements).toBeUndefined();
},60000);
it("never falls back from an uninstrumented bundle to source mode",async()=>{
  const file=join(dir,"uninstrumented.mjs");await build({stdin:{contents:entry,resolveDir:app},bundle:true,platform:"node",format:"esm",target:"node22",outfile:file});
  const receipt=execute(file);expect(receipt.identity).toMatchObject({status:"unmeasured",reason:"bundle-identity-manifest-required"});
},60000);
it("does not describe rewritten on-disk bytes as the already loaded bundle",async()=>{
  const contents=`import {appendFile,readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {sampleMaterialColor} from './src/application/materialColorSampling.ts';await appendFile(fileURLToPath(import.meta.url),'\\n// post-load drift\\n');const args=JSON.parse(await readFile(process.argv[2],'utf8'));console.log(JSON.stringify(await sampleMaterialColor(args.request,args.runtime)));`;
  const built=await buildMaterialColorBundle({absWorkingDir:app,stdin:{contents,resolveDir:app},outfile:join(dir,"post-load/bundle.mjs")});
  expect(execute(built.outfile).identity).toMatchObject({status:"unmeasured",reason:"loaded-code-bytes-drift"});
},60000);
it("records explicit live source identity without a bundle sidecar",async()=>{
  const identity=await getMaterialColorRuntimeIdentity(runtime);expect(identity.status,JSON.stringify(identity)).toBe("verified");expect(identity.code).toMatchObject({mode:"source",entry:"materialColorCodeIdentity.ts"});expect(identity.code!.sha256).toBe(colorBytesSha(await readFile(resolve(app,"src/application/materialColorCodeIdentity.ts"))));
},60000);
it.each(['valid','missing-context','wrong-executed-bytes','live-drift','sidecar-drift'])("generation data-byte bridge: %s",async mode=>{
  const folder=join(dir,`generation-${mode}`);await mkdir(folder);const file=join(folder,'bundle.mjs');await copyFile(bundle,file);await copyFile(sidecar,`${file}.material-color-identity.json`);
  const helper=pathToFileURL(resolve(app,'scripts/lib/material-color-generation-bridge.mjs')).href;
  const snapshot={entrypoint:file,manifest:{entrypoint:'runtime/bundle.mjs',files:[{path:'runtime/bundle.mjs.material-color-identity.json',sha256:colorBytesSha(await readFile(sidecar))}]}};
  const wrapper=join(folder,'runner.mjs');
  const action=mode==='missing-context'?`await import('data:text/javascript;base64,'+snapshot.entrypointBytes.toString('base64'));`:`await importVerifiedMaterialColorGeneration(snapshot,async url=>{${mode==='wrong-executed-bytes'?`url='data:text/javascript;base64,'+Buffer.concat([snapshot.entrypointBytes,Buffer.from('\\n// changed executed bytes')]).toString('base64');`:mode==='live-drift'?`await appendFile(snapshot.entrypoint,'\\n// live drift');`:mode==='sidecar-drift'?`await appendFile(snapshot.entrypoint+'.material-color-identity.json',' ');`:''}return import(url);});`;
  await writeFile(wrapper,`import {readFile,appendFile} from 'node:fs/promises';import {importVerifiedMaterialColorGeneration} from ${JSON.stringify(helper)};const snapshot=${JSON.stringify(snapshot)};snapshot.entrypointBytes=await readFile(snapshot.entrypoint);try{${action}}catch(e){console.log(JSON.stringify({rejected:e.message}));}`);
  const receipt=execute(wrapper);await writeFile(join(folder,'result.json'),JSON.stringify(receipt,null,2));
  if(mode==='valid'){expect(receipt.status,JSON.stringify(receipt)).toBe('measured');verifyMaterialColorReceipt(receipt);expect(receipt.identity.code.sha256).toBe(colorBytesSha(await readFile(bundle)));}
  else if(mode==='missing-context')expect(receipt.rejected).toBe('verified-data-bundle-context-required');
  else if(mode==='wrong-executed-bytes')expect(receipt.rejected).toBe('executed-data-bundle-identity-mismatch');
  else {expect(receipt.status).toBe('unmeasured');expect(receipt.identity.status).toBe('unmeasured');}
},60000);
it("serves real prepare_ai_material from canonical bundled MCP with an owned project",async()=>{
  const folder=join(dir,"mcp");const built=await buildMaterialColorBundle({absWorkingDir:app,entryPoints:["src/mcp/server.ts"],outfile:join(folder,"mcp.mjs"),minify:true,legalComments:"none"});
  const project=createEmptyProject("bundle color diagnostic",{width:64,height:96,fps:10});project.assets=[{id:"asset",name:"tagged",kind:"video",uri:request.sourcePath as string,duration:2}];project.tracks[0].clips=[{id:"clip",assetId:"asset",trackId:project.tracks[0].id,timelineStart:0,sourceStart:0,duration:1,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}];
  const projectPath=join(dir,"fixture.editkin.json");await writeFile(projectPath,JSON.stringify(project));
  const cache=join(dir,"mcp-cache"),client=new Client({name:"color-bundle-probe",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[built.outfile],cwd:folder,env:{...process.env,EDITKIN_WORKSPACE:dir,EDITKIN_CACHE_ROOT:cache,EDITKIN_MODEL_ROOT:join(dir,"no-model"),HAO_FFMPEG_PATH:runtime.ffmpegPath,HAO_FFPROBE_PATH:runtime.ffprobePath} as Record<string,string>,stderr:"pipe"});
  let stderr="";try{
    await client.connect(transport);transport.stderr?.on("data",chunk=>{stderr+=String(chunk);});
    const result=await client.callTool({name:"prepare_ai_material",arguments:{projectPath,clipId:"clip",includeTranscript:false,maxKeyframes:2}},{timeout:60000});
    await writeFile(join(dir,"mcp-result.json"),JSON.stringify({result,stderr},null,2));expect(result.isError,JSON.stringify(result)).not.toBe(true);
    const payload=JSON.parse(String((result.content as Array<{type:string;text?:string}>).find(x=>x.type==="text")?.text));
    const packet=JSON.parse(await readFile(join(cache,"material-intelligence",payload.packet.materialId,"manifest.json"),"utf8"));
    expect(packet.analysis.color.status,JSON.stringify(packet.analysis.color)).toBe("measured");verifyMaterialColorReceipt(packet.analysis.color);expect(packet.analysis.color.identity.code.sha256).toBe(built.manifest.bundle.sha256);
    await writeFile(join(dir,"mcp-color-receipt.json"),JSON.stringify(packet.analysis.color,null,2));
  }finally{await client.close();}
},90000);
