import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import type {EditProject} from '../src/domain/types';

const app=resolve(import.meta.dirname,'..');
const root=await mkdtemp(join(app,'.rd/ui-library-20260831/integration-'));
const runtime={creativePackRoot:resolve(app,'.rd/ui-library-20260831/creator-library-preview-candidate'),personalMusicRoot:resolve(app,'.personal-packs/hao-music-library'),personalVisualRoot:resolve(app,'.personal-packs/hao-visual-library'),ffmpeg:resolve(app,'vendor/ffmpeg/win32-x64/ffmpeg.exe'),ffprobe:resolve(app,'vendor/ffmpeg/win32-x64/ffprobe.exe'),fontRoot:resolve(app,'public/fonts'),cacheRoot:join(root,'cache')};
const tsx=resolve(app,'node_modules/tsx/dist/cli.mjs'),rows:unknown[]=[];
const serviceCommand=process.env.HAO_SERVICE_COMMAND??process.execPath;
const serviceArgs=process.env.HAO_SERVICE_ARGS_JSON?JSON.parse(process.env.HAO_SERVICE_ARGS_JSON) as string[]:[tsx,'src/service/cli.ts'];
const mcpCommand=process.env.HAO_MCP_COMMAND??process.execPath;
const mcpArgs=process.env.HAO_MCP_ARGS_JSON?JSON.parse(process.env.HAO_MCP_ARGS_JSON) as string[]:[tsx,'src/mcp/server.ts'];
let ordinal=0;
async function service(command:string,payload:Record<string,unknown>){
 const request={command,payload,runtime};
 const result=spawnSync(serviceCommand,serviceArgs,{cwd:app,input:JSON.stringify(request),windowsHide:true,timeout:120000,maxBuffer:16*1024*1024});
 const output=result.stdout?.toString()??'';const parsed=output?JSON.parse(output):{};
 await writeFile(join(root,`${++ordinal}-service-${command}.json`),JSON.stringify({request,exit:result.status,stderr:result.stderr?.toString(),output:parsed},null,2));
 assert.equal(result.status,0,parsed.error??String(result.error));assert.equal(parsed.ok,true,parsed.error);return parsed.result;
}
const env={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),EDITKIN_WORKSPACE:root,EDITKIN_CREATIVE_PACK_ROOT:runtime.creativePackRoot,EDITKIN_PERSONAL_MUSIC_ROOT:runtime.personalMusicRoot,EDITKIN_PERSONAL_VISUAL_ROOT:runtime.personalVisualRoot,EDITKIN_CACHE_ROOT:runtime.cacheRoot,HAO_FFMPEG_PATH:runtime.ffmpeg,HAO_FFPROBE_PATH:runtime.ffprobe,EDITKIN_FONT_ROOT:runtime.fontRoot,EDITKIN_PLUGIN_ROOTS:resolve(app,'plugins')};
const client=new Client({name:'private-visual-source-integration',version:'1'});
const transport=new StdioClientTransport({command:mcpCommand,args:mcpArgs,cwd:app,env,stderr:'pipe'});
async function call(name:string,args:Record<string,unknown>){
 const raw=await client.callTool({name,arguments:args},{timeout:180000,maxTotalTimeout:180000});
 await writeFile(join(root,`${++ordinal}-mcp-${name}.json`),JSON.stringify({arguments:args,result:raw},null,2));
 assert.notEqual(raw.isError,true,JSON.stringify(raw));
 const contents=raw.content as Array<{type:string;text?:string}>;return JSON.parse(contents.find(c=>c.type==='text')!.text!);
}
try{
 const library=await service('list_creative_library',{});
 assert.equal(library.restrictedAssetCount,2);assert.equal(library.assetCount,1081);assert.equal(library.musicAssetCount,175);
 const privateAssets=library.assets.filter((a:{category:string})=>a.category==='private_animation');assert.equal(privateAssets.length,2);
 const publicVideo=library.assets.find((a:{id:string;mediaKind:string;preview?:{poster:boolean}})=>!a.id.startsWith('private-visual:')&&a.mediaKind==='video'&&a.preview?.poster);
 await service('resolve_creative_preview',{assetId:publicVideo.id,mode:'poster'});await service('resolve_creative_preview',{assetId:publicVideo.id,mode:'media'});
 await client.connect(transport);
 const listed=await call('list_creative_assets',{category:'private_animation',limit:100});assert.equal(listed.assets.length,2);
 for(let i=0;i<privateAssets.length;i++){
  const item=privateAssets[i],original=await service('resolve_creative_asset',{assetId:item.id});
  const poster=await service('resolve_creative_preview',{assetId:item.id,mode:'poster'}),proxy=await service('resolve_creative_preview',{assetId:item.id,mode:'media'});
  assert.notEqual(original.absolutePath,proxy.absolutePath);assert.notEqual(original.sha256,proxy.sha256);
  const inspected=await service('inspect_media',{path:original.absolutePath});
  const projectPath=`animation-${i}.editkin.json`;
  await call('create_project',{projectPath,name:`Integration ${item.name}`,width:640,height:360,fps:30});
  let project=await service('read_project',{path:join(root,projectPath)}) as EditProject;
  const trackId=project.tracks.find(t=>t.kind==='video')!.id;
  await call('add_creative_asset_to_timeline',{projectPath,creativeAssetId:item.id,assetId:`asset-${i}`,clipId:`clip-${i}`,trackId,timelineStart:0});
  project=await service('read_project',{path:join(root,projectPath)}) as EditProject;
  const asset=project.assets.find(a=>a.id===`asset-${i}`)!;
  assert.equal(asset.uri,`creative://studio.hao.creator-library/${encodeURIComponent(item.id)}`);
  assert.equal(asset.license,'PRIVATE-OWNER-ONLY');assert.equal(asset.rightsBasis,'private-owner-only');assert.equal(asset.distributionScope,'private-owner-only');assert.equal(asset.redistributable,false);
  assert.equal(asset.width,inspected.width);assert.equal(asset.height,inspected.height);assert.equal(asset.duration,inspected.duration);
  assert.equal(asset.color?.transfer,inspected.colorTransfer);
  await call('apply_edit_commands',{projectPath,commands:[{type:'trim_clip_end',clipId:`clip-${i}`,seconds:project.tracks.find(t=>t.id===trackId)!.clips[0].duration-1},{type:'set_clip_volume',clipId:`clip-${i}`,volume:0}]});
  project=await service('read_project',{path:join(root,projectPath)}) as EditProject;
  const reopen=join(root,`reopened-${i}.editkin.json`);await service('write_project',{path:reopen,project,expectedRevision:null});
  const readBack=await service('read_project',{path:reopen});assert.deepEqual(readBack.assets,project.assets);
  await call('get_project_summary',{projectPath:`reopened-${i}.editkin.json`});
  const rendered=await call('render_project',{projectPath:`reopened-${i}.editkin.json`,outputPath:`animation-${i}.mp4`,preferGpu:false});
  const output=await service('inspect_media',{path:join(root,`animation-${i}.mp4`)});assert.ok(output.duration>=.96&&output.duration<=1.05);
  const final=await service('read_project',{path:reopen});assert.equal(final.assets.find((a:{id:string})=>a.id===asset.id).uri,asset.uri);
  rows.push({id:item.id,name:item.name,original,poster,proxy,inspected,rendered,output,storedAsset:asset});
 }
 await writeFile(join(root,'report.json'),JSON.stringify({status:'PASS_SOURCE_SERVICE_MCP_NOT_PACKAGED_OR_ART_APPROVAL',runtime,rows},null,2));
 console.log(JSON.stringify({status:'PASS',root,animations:rows.length}));
}catch(error){await writeFile(join(root,'report.json'),JSON.stringify({status:'FAIL',error:String(error),stack:error instanceof Error?error.stack:undefined,runtime,rows},null,2));console.error(JSON.stringify({status:'FAIL',root,error:String(error)}));process.exitCode=1;}
finally{await client.close();}
