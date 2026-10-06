import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { validateProject } from "../src/domain/editGraph";
const root=resolve(import.meta.dirname,".."),evidence=join(root,".rd/benchmarks/native-mesh3d-20260930"),path=join(evidence,"mcp-journey.editkin.json"),sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const p=JSON.parse(await readFile(join(evidence,"showcase.editkin.json"),"utf8"));delete p.scene3d;p.id="mesh-mcp-source-journey";p.tracks[0].clips=p.tracks[0].clips.slice(0,1);p.tracks[0].clips[0].duration=3;p.tracks[1].clips[0].duration=3;validateProject(p);await writeFile(path,JSON.stringify(p,null,2));
const client=new Client({name:"mesh3d-source-journey",version:"1.0"}),transport=new StdioClientTransport({command:process.execPath,args:[join(root,"node_modules/tsx/dist/cli.mjs"),"src/mcp/server.ts"],cwd:root,env:Object.fromEntries(Object.entries({...process.env,EDITKIN_WORKSPACE:resolve(root,"../.."),EDITKIN_MCP_MODE:"",HAO_FFMPEG_PATH:join(root,"vendor/ffmpeg/win32-x64/ffmpeg.exe"),HAO_FFPROBE_PATH:join(root,"vendor/ffmpeg/win32-x64/ffprobe.exe")}).filter((value):value is [string,string]=>value[1]!==undefined)),stderr:"pipe"});
function payload(result:any){if(result.isError)throw new Error(JSON.stringify(result.content));return JSON.parse(result.content.find((c:any)=>c.type==="text").text);}
try{
  await client.connect(transport);const tools=await client.listTools();for(const name of ["list_mesh_3d_templates","prepare_mesh_3d_template","apply_edit_commands","render_project"])if(!tools.tools.some(t=>t.name===name))throw new Error(`缺少 source MCP ${name}`);
  const catalog=payload(await client.callTool({name:"list_mesh_3d_templates",arguments:{}})),before=sha(await readFile(path)),prepared=payload(await client.callTool({name:"prepare_mesh_3d_template",arguments:{projectPath:path,templateId:"extruded_typography",clipId:"texture-0",title:"真實素材"}}));
  if(before!==sha(await readFile(path)))throw new Error("MCP prepare 污染專案");
  const applied=payload(await client.callTool({name:"apply_edit_commands",arguments:{projectPath:path,commands:prepared.commands}})),reopened=validateProject(JSON.parse(await readFile(path,"utf8")));
  if(!reopened.scene3d?.enabled)throw new Error("MCP 原子 apply 未保存 3D 場景");
  const rendered=payload(await client.callTool({name:"render_project",arguments:{projectPath:path,outputPath:"apps/hao-editor/.rd/benchmarks/native-mesh3d-20260930/mcp-journey.mp4",preferGpu:false}},{timeout:180000}));
  if(rendered.mesh3dPipeline?.executor!=="shared-cpu-triangle-zbuffer/v1"||rendered.artifactIdentity?.durationFrames!==90)throw new Error("MCP 產生的實際 mesh 渲染／輸出身分不符");
  const result={schema:"editkin.mesh3d-mcp-source-journey/v1",sourceOnly:true,installedGeneration:false,discovery:true,catalog,prepareReadOnly:true,applied,reopenedScene:reopened.scene3d,rendered};await writeFile(join(evidence,"mcp-source-journey.json"),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify({sourceOnly:true,discovered:catalog.templates.length,prepareReadOnly:true,applyReopened:true,actualFrames:rendered.artifactIdentity.durationFrames,executor:rendered.mesh3dPipeline.executor})+"\n");
}finally{await client.close();}
