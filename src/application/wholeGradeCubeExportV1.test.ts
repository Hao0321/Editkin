import {it,expect,vi} from 'vitest';
import {mkdtemp,readdir,rmdir,stat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createDemoProject} from '../domain/demo';
const calls=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('../render/wholeGradeCubeProcessV1',()=>({runWholeGradeCubeProcessV1:calls.run}));
import {exportWholeGradeCubeV1} from './wholeGradeCubeExportV1';
const parent=resolve('.rd/benchmarks/usable-v1-20261009/work/tmp-codex');
it('builds the old look adapter with its required creative defaults and leaves no owned staging',async()=>{
  const root=await mkdtemp(join(parent,'whole-grade-control-')),jobs=join(root,'jobs');
  const p=createDemoProject(),c=p.tracks[0].clips[0];c.creative={lookPresetId:'clean_neutral',effectPresetIds:[]};c.color.exposure=.1;const before=JSON.stringify(p);
  calls.run.mockImplementation(async(options:any)=>({bytes:Buffer.alloc(options.maximumOutput),stderr:'',pid:123,code:0,closed:true,startedUtc:'2026-10-14T00:00:00Z',elapsedMs:1,executableBefore:{sha256:'0'.repeat(64)},executableAfter:{sha256:'0'.repeat(64)}}));
  try{
    const r=await exportWholeGradeCubeV1(p,c.id,0,{workRoot:jobs,ffmpegPath:resolve('owned/ffmpeg.exe'),ffmpegSha256:'0'.repeat(64),size:2});
    expect(r.snapshot.legacyLookId).toBe('clean_neutral');expect(calls.run.mock.lastCall![0].args.join(' ')).toContain("+(0.02)+(0)");expect(calls.run.mock.lastCall![0].args.join(' ')).toContain('exposure=');
    expect(JSON.stringify(p)).toBe(before);expect(await readdir(jobs)).toEqual([]);
  }finally{expect(relative(parent,root)).not.toMatch(/^\.\./);await rmdir(jobs);await rmdir(root);}
});
it('pre-cancelled export does not create a job or alter project data',async()=>{
  const p=createDemoProject(),before=JSON.stringify(p),controller=new AbortController();controller.abort();calls.run.mockClear();const absent=join(parent,'whole-grade-pre-abort-must-not-exist');
  await expect(exportWholeGradeCubeV1(p,p.tracks[0].clips[0].id,0,{workRoot:absent,ffmpegPath:resolve('owned/ffmpeg.exe'),ffmpegSha256:'0'.repeat(64),signal:controller.signal})).rejects.toThrow();
  expect(calls.run).not.toHaveBeenCalled();expect(JSON.stringify(p)).toBe(before);await expect(stat(absent)).rejects.toMatchObject({code:'ENOENT'});
});
