import {beforeAll,afterAll,expect,it} from "vitest";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {buildShotGradeBundleV1} from "../../scripts/lib/shot-grade-bundle-identity-v1.mjs";
import {createShotGradeFixtureV1} from "../test/shotGradeFixtureV1";
import {useTempRoots} from "../test/tempRoot.mjs";
import {colorBytesSha} from "../application/materialColorSamplingRuntime";
import type {MaterialIntelligencePacket} from "../application/materialIntelligence";
const app=fileURLToPath(new URL("../../",import.meta.url)),temp=useTempRoots();
let f:Awaited<ReturnType<typeof createShotGradeFixtureV1>>,client:Client,cache:string,bundle:string,request:Record<string,unknown>,projectBytes:Buffer,stderr="";
function payload(result:{content?:unknown;isError?:boolean}){expect(result.isError,JSON.stringify(result)).not.toBe(true);const text=(result.content as Array<{type:string;text?:string}>).find(row=>row.type==="text")?.text;return JSON.parse(text!);}
beforeAll(async()=>{
 f=await createShotGradeFixtureV1(temp);cache=join(f.root,"bundled-cache");projectBytes=await readFile(f.projectPath);
 const built=await buildShotGradeBundleV1({absWorkingDir:app,entryPoints:["src/mcp/server.ts"],outfile:join(f.root,"bundled/mcp.mjs"),minify:true,legalComments:"none"});bundle=built.outfile;
 client=new Client({name:"owned-shot-grade-probe",version:"1"});const transport=new StdioClientTransport({command:process.execPath,args:[bundle],cwd:f.root,
  env:{...process.env,EDITKIN_WORKSPACE:f.root,EDITKIN_CACHE_ROOT:cache,EDITKIN_MODEL_ROOT:join(f.root,"no-model"),HAO_FFMPEG_PATH:f.runtime.ffmpegPath,HAO_FFPROBE_PATH:f.runtime.ffprobePath} as Record<string,string>,stderr:"pipe"});
 transport.stderr?.on("data",chunk=>{stderr+=String(chunk);if(stderr.length>1024*1024)throw Error("Owned MCP stderr byte budget exceeded");});await client.connect(transport);
 const prepare=async(clipId:string)=>{
  const prepared=payload(await client.callTool({name:"prepare_ai_material",arguments:{projectPath:f.projectPath,clipId,includeTranscript:false,maxKeyframes:2,execution:"sync"}},{timeout:60000}));
  const packet=JSON.parse(await readFile(join(cache,"material-intelligence",prepared.packet.materialId,"manifest.json"),"utf8")) as MaterialIntelligencePacket;
  expect(packet.analysis.color?.status).toBe("measured");expect(packet.analysis.color!.identity.code?.sha256).toBe(built.manifest.bundle.sha256);
  const seen=await client.callTool({name:"view_material_keyframes",arguments:{materialId:packet.materialId,frameIds:packet.keyframes.map(row=>row.id)}},{timeout:60000});expect(seen.isError,JSON.stringify(seen)).not.toBe(true);
  expect((seen.content as Array<{type:string}>).filter(row=>row.type==="image").length).toBe(packet.keyframes.length);
  const semantics=payload(await client.callTool({name:"record_material_semantics",arguments:{materialId:packet.materialId,sourceSha256:packet.source.sourceSha256,
   overallTopic:"Owned synthetic neutral/warm swatches",contentType:"fixture",language:"en",people:[],locations:[],segments:[{start:0,end:.6,
    summary:"Authored numeric swatches; declared test ROIs, no detected human or art certification",subjects:[],actions:[],objects:[],importance:.5,evidenceFrameIds:[packet.keyframes[0].id],transcriptCueIndexes:[]}]}},{timeout:60000}));
  return {binding:{materialId:packet.materialId,semanticReceiptSha256:semantics.receipt.semanticReceiptSha256},regions:packet.analysis.color!.mapping.flatMap(row=>[
   {sampleId:row.id,role:"neutral",x:0,y:0,width:.5,height:1},{sampleId:row.id,role:"skin",x:.5,y:0,width:.5,height:1}])};
 };
 const target=await prepare("target"),reference=await prepare("reference");request={projectPath:f.projectPath,target:target.binding,reference:reference.binding,regions:target.regions,referenceRegions:reference.regions,
  roiBasis:"local-layer-raster-normalized",reason:"Known owned numerical reference, source-only proof",maximumTimeMs:40000};
},180000);
afterAll(async()=>{if(client)await client.close();},30000);
it("serves both registered tools from actual instrumented MCP without modifying the project",async()=>{
 const tools=await client.listTools();expect(tools.tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(["propose_shot_color_match","propose_auto_balance"]));
 const match=payload(await client.callTool({name:"propose_shot_color_match",arguments:request},{timeout:60000}));expect(match.applicable,JSON.stringify(match)).toBe(true);
 expect(match.command.type).toBe("set_clip_grade_v2");expect(match.command.clipId).toBe("target");expect(match.measurements.match.matchesSpecifiedNeutralAndSkinBounds).toBe(true);
 const receipt=JSON.parse(await readFile(join(cache,"shot-grade-decisions-v1",match.decisionSha256+".json"),"utf8"));
 expect(receipt.body.codeIdentity.code.mode).toBe("bundle");expect(receipt.body.codeIdentity.code.sha256).toBe(colorBytesSha(await readFile(bundle)));expect(receipt.body.codeIdentity.implementations).toHaveLength(327);
 const {reference,referenceRegions,...balanceRequest}=request,balance=payload(await client.callTool({name:"propose_auto_balance",arguments:balanceRequest},{timeout:60000}));
 expect(balance.applicable,JSON.stringify(balance)).toBe(true);expect(balance.status).toBe("unchanged");expect(balance.vaContractAdmission).toBe(false);
 expect(await readFile(f.projectPath)).toEqual(projectBytes);expect(match.finalOutputMeasured).toBe(false);
 await writeFile(join(f.root,"owned-mcp-results.json"),JSON.stringify({match,balance,stderr},null,2));
},120000);
it("refuses a changed real source and an ambiguous ROI basis through the actual MCP",async()=>{
 const invalid=await client.callTool({name:"propose_shot_color_match",arguments:{...request,roiBasis:"uncropped-source"}},{timeout:60000});expect(invalid.isError).toBe(true);
 const bytes=await readFile(f.referenceSource);try{await writeFile(f.referenceSource,Buffer.concat([bytes,Buffer.from([0])]));const changed=await client.callTool({name:"propose_shot_color_match",arguments:request},{timeout:60000});expect(changed.isError,JSON.stringify(changed)).toBe(true);}finally{await writeFile(f.referenceSource,bytes);}
 expect(await readFile(f.projectPath)).toEqual(projectBytes);
},60000);
