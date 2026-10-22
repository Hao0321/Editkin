import {it,expect,vi,beforeEach} from 'vitest';
import {mkdtemp,readdir,rmdir,unlink,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readdirSync,writeFileSync} from 'node:fs';
import {createDemoProject} from '../domain/demo';
import {rgb8InputPlanesV1} from '../render/rgb8CubePlanePipeV1';
const control=vi.hoisted(()=>({mode:'good',closed:false,started:0,graph:'',abort:undefined as AbortController|undefined}));
vi.mock('node:crypto',async original=>({...await original<typeof import('node:crypto')>(),randomUUID:()=> '11111111-1111-4111-8111-111111111111'}));
vi.mock('../render/rgb8CubePlanePipeV1',async original=>({...await original<typeof import('../render/rgb8CubePlanePipeV1')>(),rgb8CubePlanePipeV1:async function*(options:any){
  control.started++;control.graph=options.args.join(' ');let count=0;
  try{for(const plane of rgb8InputPlanesV1(options.size,Array.from({length:options.size},(_,i)=>i))){if(control.mode==='fail'&&count===1)throw Error('producer sentinel');count++;yield plane;if(control.mode==='abort'){control.abort?.abort();options.signal?.throwIfAborted();}}}
  finally{control.closed=true;options.onReceipt?.({pid:1,closed:true,code:control.mode==='good'?0:1,inputFrames:count,outputFrames:count,inputBytes:count*options.size**2*3,outputBytes:count*options.size**2*3});}
}}));
import {exportRgb8WholeGradeFileV1} from './rgb8WholeGradeFileV1';
const parent=resolve('.rd/benchmarks/usable-v1-20261009/work/tmp-codex');
beforeEach(()=>{control.mode='good';control.closed=false;control.started=0;control.graph='';control.abort=undefined;});
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(parent,'rgb8-file-control-'));try{await run(root);}finally{expect(await readdir(root)).toEqual([]);await rmdir(root);}}
const runtime=(root:string)=>({artifactRoot:root,ffmpegPath:resolve('unused.exe'),ffmpegSha256:'0'.repeat(64),size:2,maximumBytes:2048,quotaBytes:20*1024*1024,reserveBytes:0});
it('commits exact file bytes plus durable scope receipt; preserves current recipe and project',async()=>fixture(async root=>{
  const p=createDemoProject(),c=p.tracks[0].clips[0];c.creative={lookPresetId:'clean_neutral',effectPresetIds:[]};c.color.exposure=.1;const before=JSON.stringify(p),promise=exportRgb8WholeGradeFileV1(p,c.id,0,runtime(root));c.color.exposure=4;
  const r=await promise;expect(control.closed).toBe(true);expect(r.snapshot.color.exposure).toBe(.1);expect(control.graph).toContain('eq=');expect(control.graph).toContain('exposure=');
  expect(r.receipt).toMatchObject({size:2,vertexCount:8,fullByteGrid:false,inputBasis:'after-source-decode-and-normalization-opaque-RGB8',originalFloatCaseComplete:false,installedNativeGUI:false});expect(r.receipt.attributions[0].id).toBe('clean_neutral');
  const text=await readFile(r.artifactPath);expect(text.length).toBe(r.receipt.artifact.bytes);expect(JSON.parse(await readFile(r.receiptPath,'utf8')).artifact.sha256).toBe(r.receipt.artifact.sha256);expect(await readdir(root)).toHaveLength(2);
  c.color.exposure=.1;expect(JSON.stringify(p)).toBe(before);await unlink(r.artifactPath);await unlink(r.receiptPath);
}));
it('incomplete producer closes and removes only its owned staging before rejection',async()=>fixture(async root=>{
  control.mode='fail';const p=createDemoProject();await writeFile(join(root,'user-preserved.txt'),'sentinel',{flag:'wx'});
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,runtime(root))).rejects.toThrow('producer sentinel');expect(control.closed).toBe(true);expect(await readdir(root)).toEqual(['user-preserved.txt']);expect(await readFile(join(root,'user-preserved.txt'),'utf8')).toBe('sentinel');await unlink(join(root,'user-preserved.txt'));
}));
it('rejects capacity before producer work and leaves existing artifacts intact',async()=>fixture(async root=>{
  const p=createDemoProject();await writeFile(join(root,'retained.cube'),'sentinel',{flag:'wx'});
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,{...runtime(root),quotaBytes:1024})).rejects.toThrow('空間');expect(control.started).toBe(0);expect(await readdir(root)).toEqual(['retained.cube']);await unlink(join(root,'retained.cube'));
}));
it('rejects concurrent or orphan lease without deleting it',async()=>fixture(async root=>{
  const p=createDemoProject(),path=join(root,'.rgb8-export.lock');await writeFile(path,'other-owner',{flag:'wx'});
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,runtime(root))).rejects.toMatchObject({code:'EEXIST'});expect(await readFile(path,'utf8')).toBe('other-owner');expect(control.started).toBe(0);await unlink(path);
}));
it('pre-abort and invalid budget create no lease or native job',async()=>fixture(async root=>{
  const p=createDemoProject(),c=new AbortController();c.abort();await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,{...runtime(root),signal:c.signal})).rejects.toThrow();
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,{...runtime(root),size:256})).rejects.toThrow('預算');expect(control.started).toBe(0);
}));
it('unknown directories remain intact and block the dedicated artifact root',async()=>fixture(async root=>{
  const p=createDemoProject(),path=join(root,'unknown-job');await mkdir(path);await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,runtime(root))).rejects.toThrow('目錄');expect(control.started).toBe(0);expect(await readdir(root)).toEqual(['unknown-job']);await rmdir(path);
}));
it('midstream cancellation closes the producer and publishes no partial cube',async()=>fixture(async root=>{
  const p=createDemoProject(),abort=new AbortController();control.mode='abort';control.abort=abort;
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,{...runtime(root),signal:abort.signal})).rejects.toThrow();expect(control.closed).toBe(true);expect(await readdir(root)).toEqual([]);
}));
it('publication collision preserves the existing cube and rolls back its own receipt',async()=>fixture(async root=>{
  const p=createDemoProject(),existing=join(root,'rgb8-11111111-1111-4111-8111-111111111111.cube');await writeFile(existing,'user-original',{flag:'wx'});
  await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,runtime(root))).rejects.toMatchObject({code:'EEXIST'});expect(control.closed).toBe(true);expect(await readdir(root)).toEqual(['rgb8-11111111-1111-4111-8111-111111111111.cube']);expect(await readFile(existing,'utf8')).toBe('user-original');await unlink(existing);
}));
it('staging tamper prevents publication and retains altered data for inspection',async()=>fixture(async root=>{
  const p=createDemoProject();await expect(exportRgb8WholeGradeFileV1(p,p.tracks[0].clips[0].id,0,{...runtime(root),onReceipt:()=>{const job=readdirSync(root).find(name=>name.startsWith('.rgb8-job-'))!;writeFileSync(join(root,job,'output.cube'),'changed-after-process-close');}})).rejects.toThrow('暫存身分');
  expect(control.closed).toBe(true);const names=await readdir(root);expect(names.some(name=>name.endsWith('.cube'))).toBe(false);const job=join(root,names.find(name=>name.startsWith('.rgb8-job-'))!);expect(await readFile(join(job,'output.cube'),'utf8')).toBe('changed-after-process-close');
  // Explicit cleanup of this test's deliberately changed fixture, after observation.
  await unlink(join(job,'output.cube'));await rmdir(job);await unlink(join(root,'.rgb8-export.lock'));
}));
