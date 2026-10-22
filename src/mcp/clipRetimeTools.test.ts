import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/server";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { runConversionProcess } from "../application/mediaConversion";
import { readProject, writeProject } from "./storage";
import { registerClipRetimeTools } from "./clipRetimeTools";

interface Tool {configuration:{inputSchema:{parse:(input:unknown)=>unknown}};handler:(input:unknown,context:unknown)=>Promise<{content:Array<{text:string}>;isError?:boolean}>}
const tools=new Map<string,Tool>(),app=resolve(import.meta.dirname,'../..');
const previous={workspace:process.env.EDITKIN_WORKSPACE,ffmpeg:process.env.HAO_FFMPEG_PATH,ffprobe:process.env.HAO_FFPROBE_PATH};
let root:string,source:string;
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'editkin-clip-tools-real-'));source=join(root,'source.mp4');process.env.EDITKIN_WORKSPACE=root;
  process.env.HAO_FFMPEG_PATH=join(app,'vendor/ffmpeg/win32-x64/ffmpeg.exe');process.env.HAO_FFPROBE_PATH=join(app,'vendor/ffmpeg/win32-x64/ffprobe.exe');
  await runConversionProcess(process.env.HAO_FFMPEG_PATH,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=4',
    '-c:v','libx264','-threads','2','-preset','ultrafast','-pix_fmt','yuv420p',source]);
  registerClipRetimeTools({registerTool:(name:string,configuration:Tool['configuration'],handler:Tool['handler'])=>tools.set(name,{configuration,handler})} as unknown as McpServer);
},60_000);
afterAll(async()=>{
  for(const [key,value] of [['EDITKIN_WORKSPACE',previous.workspace],['HAO_FFMPEG_PATH',previous.ffmpeg],['HAO_FFPROBE_PATH',previous.ffprobe]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if(!root)return;
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('editkin-clip-tools-real-'))throw Error('Unowned fixture cleanup');
  await rm(root,{recursive:true,force:true});
});
async function saved(label:string){
  const project=createEmptyProject(label,{id:label,width:160,height:90,fps:30}),track=project.tracks[0];
  project.assets=[{id:'original',kind:'video',name:'Original',uri:source,duration:4,width:160,height:90}];
  track.clips=[0,2].map((start,index)=>({id:index?'B':'A',assetId:'original',trackId:track.id,timelineStart:start,sourceStart:start,duration:2,
    volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]}));
  const path=join(root,`${label}.editkin.json`);await writeFile(path,JSON.stringify(project));return {project,path};
}
async function call(name:string,input:unknown){
  const tool=tools.get(name)!;return tool.handler(tool.configuration.inputSchema.parse(input),{mcpReq:{signal:new AbortController().signal}});
}
describe('actual MCP clip media writes',()=>{
  it('exposes two additive tools with required revisions and executes an actual freeze atomically',async()=>{
    expect([...tools.keys()]).toEqual(['freeze_frame','clip_retime']);
    expect(()=>tools.get('freeze_frame')!.configuration.inputSchema.parse({projectPath:'x',clipId:'A',playhead:1})).toThrow();
    const fixture=await saved('freeze');const result=await call('freeze_frame',{projectPath:fixture.path,clipId:'A',playhead:1,expectedRevision:0});
    expect(result.isError).not.toBe(true);expect(JSON.parse(result.content[0].text)).toMatchObject({status:'GREEN',duration:2});
    const updated=await readProject(fixture.path);
    expect(updated.tracks[0].clips.map(clip=>[clip.timelineStart,clip.duration])).toEqual([[0,1],[1,2],[3,1],[4,2]]);
    expect(updated.assets.find(asset=>asset.kind==='image')?.derivatives?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  },60_000);
  it('executes a real2x retime and rejects a stale revision without writing',async()=>{
    const fixture=await saved('retime');const result=await call('clip_retime',{projectPath:fixture.path,clipId:'A',rate:2,reverse:false,expectedRevision:0});
    expect(result.isError).not.toBe(true);expect(JSON.parse(result.content[0].text)).toMatchObject({status:'GREEN',rate:2,duration:1});
    const updated=await readProject(fixture.path),before=await readFile(fixture.path);
    expect(updated.tracks[0].clips.map(clip=>[clip.timelineStart,clip.duration])).toEqual([[0,1],[1,2]]);
    expect(updated.assets.find(asset=>asset.clipRetime)?.clipRetime).toMatchObject({sourceAssetId:'original',rate:2,reverse:false});
    expect((await call('clip_retime',{projectPath:fixture.path,clipId:'A',rate:.5,expectedRevision:0})).isError).toBe(true);
    expect(await readFile(fixture.path)).toEqual(before);
  },60_000);
  it('keeps an external newer revision when the project changes during actual frame extraction',async()=>{
    const fixture=await saved('race'),cache=join(root,'.editkin-media-cache/clip-edits');
    const before=new Set(await readdir(cache));
    const pending=call('freeze_frame',{projectPath:fixture.path,clipId:'A',playhead:1,expectedRevision:0});
    const deadline=Date.now()+15_000;
    while(!(await readdir(cache)).some(name=>!before.has(name))){if(Date.now()>deadline)throw Error('Derivative never entered generation');await new Promise(accept=>setTimeout(accept,20));}
    const changed={...fixture.project,name:'External newer project'};await writeProject(fixture.path,changed,0);
    expect((await pending).isError).toBe(true);
    const result=await readProject(fixture.path);expect(result.name).toBe('External newer project');expect(result.assets).toHaveLength(1);
  },60_000);
});
