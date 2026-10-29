import {describe,it,expect,vi,beforeEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const state=vi.hoisted(()=>({spawn:vi.fn(),mode:'good'}));
vi.mock('node:child_process',()=>({spawn:state.spawn}));
vi.mock('node:fs',()=>({createReadStream:()=>({async *[Symbol.asyncIterator](){yield Buffer.from('owned executable');}})}));
vi.mock('node:fs/promises',()=>({lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:16}),realpath:async(p:string)=>p}));
import {runWholeGradeCubeProcessV1} from './wholeGradeCubeProcessV1';
const options=()=>({ffmpegPath:resolve('owned/ffmpeg.exe'),ffmpegSha256:createHash('sha256').update('owned executable').digest('hex'),args:['bounded'],input:new Uint8Array([1,2]),maximumOutput:4,timeoutMs:1000});
beforeEach(()=>{state.spawn.mockReset();state.mode='good';state.spawn.mockImplementation(()=>{
  const c=new EventEmitter() as EventEmitter&{pid:number;stdout:EventEmitter;stderr:EventEmitter;stdin:EventEmitter&{end:(bytes:unknown)=>void};kill:()=>void};c.pid=123;c.stdout=new EventEmitter();c.stderr=new EventEmitter();
  c.kill=vi.fn(()=>queueMicrotask(()=>c.emit('close',1,null)));c.stdin=Object.assign(new EventEmitter(),{end:()=>{queueMicrotask(()=>c.stdout.emit('data',Buffer.alloc(state.mode==='overflow'?8:3)));queueMicrotask(()=>c.emit('close',0,null));}});return c;
});});
describe('Owned one-frame cube child',()=>{
  it('binds executable bytes and observes child close before returning bounded output',async()=>{
    const r=await runWholeGradeCubeProcessV1(options());expect(r.bytes.length).toBe(3);expect(r.closed).toBe(true);expect(r.code).toBe(0);expect(r.executableAfter).toEqual(r.executableBefore);expect(state.spawn.mock.calls[0][2]).toMatchObject({windowsHide:true,stdio:['pipe','pipe','pipe']});
  });
  it('refuses changed pin and pre-cancelled requests without starting a child',async()=>{
    await expect(runWholeGradeCubeProcessV1({...options(),ffmpegSha256:'0'.repeat(64)})).rejects.toThrow(/版本/);expect(state.spawn).not.toHaveBeenCalled();
    const c=new AbortController();c.abort();await expect(runWholeGradeCubeProcessV1({...options(),signal:c.signal})).rejects.toThrow();expect(state.spawn).not.toHaveBeenCalled();
  });
  it('oversized output kills its own child and rejects with terminal evidence',async()=>{
    state.mode='overflow';try{await runWholeGradeCubeProcessV1(options());expect.fail('must reject');}catch(e){expect((e as Error).message).toMatch(/上限/);expect((e as any).childReceipt.closed).toBe(true);expect(state.spawn.mock.results[0].value.kill).toHaveBeenCalled();}
  });
});
