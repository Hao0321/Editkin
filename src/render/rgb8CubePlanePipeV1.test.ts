import {it,expect,afterAll} from 'vitest';
import {mkdtemp,writeFile,unlink,rmdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {rgb8CubePlanePipeV1,rgb8InputPlanesV1,type Rgb8PlanePipeReceiptV1,type Rgb8PlanePipeOptionsV1} from './rgb8CubePlanePipeV1';
const executable=resolve('vendor/node/win32-x64/node.exe');
const hash=()=>readFile(executable).then(v=>createHash('sha256').update(v).digest('hex'));
const parent=resolve('.rd/benchmarks/usable-v1-20261009/work/tmp-codex');
const journal:Array<{args:string[];executable:string;receipt:Rgb8PlanePipeReceiptV1}>=[];
function tracked(options:Rgb8PlanePipeOptionsV1){return rgb8CubePlanePipeV1({...options,onReceipt:r=>{journal.push({args:options.args,executable:options.ffmpegPath,receipt:r});options.onReceipt?.(r);}});}
afterAll(async()=>{await writeFile(resolve('.rd/benchmarks/usable-v1-20261009/work/codex-long-4-W1/WHOLE-GRADE-STREAM-C',`PIPE_CONTROLS_${Date.now()}.json`),JSON.stringify({scope:'real Node child fixtures, not FFmpeg parity',children:journal},null,2),{flag:'wx'});});
async function fixture(mode:string,run:(path:string)=>Promise<void>){
  const root=await mkdtemp(join(parent,'rgb8-pipe-control-')),path=join(root,'child.cjs');
  const source=mode==='echo'?"process.stdin.pipe(process.stdout);":mode==='short'?"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(3)));":mode==='long'?"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(999)));":mode==='exit'?"process.exit(7);":mode==='stderr'?"process.stderr.write(Buffer.alloc(200000,120));setInterval(()=>{},1000);":"process.stdin.resume();setInterval(()=>{},1000);";
  await writeFile(path,source,{flag:'wx'});try{await run(path);}finally{await unlink(path);await rmdir(root);}
}
it('keeps red-fastest planes and starts the native process only when consumed',async()=>{
  expect([...rgb8InputPlanesV1(2,[0,1])].map(v=>[...v])).toEqual([[0,0,0,255,0,0,0,255,0,255,255,0],[0,0,255,255,0,255,0,255,255,255,255,255]]);
  let spawned=false;const iterator=rgb8CubePlanePipeV1({ffmpegPath:'absent',ffmpegSha256:'0'.repeat(64),args:[],size:2,timeoutMs:1000,onSpawn:()=>{spawned=true;}});await iterator.return(undefined);expect(spawned).toBe(false);
});
it('duplex backpressure preserves two maximum-size planes and exact hashes',async()=>fixture('echo',async path=>{
  let receipt:Rgb8PlanePipeReceiptV1|undefined;const input=[...rgb8InputPlanesV1(256,[132,133])],output=[];
  for await(const plane of tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:256,blueIndices:[132,133],timeoutMs:10000,onReceipt:r=>{receipt=r;}}))output.push(plane);
  expect(output).toEqual(input);expect(receipt).toMatchObject({closed:true,code:0,inputFrames:2,outputFrames:2,inputBytes:393216,outputBytes:393216});expect(receipt!.inputSha256).toBe(receipt!.outputSha256);expect(receipt!.executableAfter).toEqual(receipt!.executableBefore);
}));
it('consumer return closes its child before returning and emits exactly one receipt',async()=>fixture('echo',async path=>{
  const receipts:Rgb8PlanePipeReceiptV1[]=[];const iterator=tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:256,blueIndices:[132,133],timeoutMs:10000,onReceipt:r=>{receipts.push(r);}});
  expect((await iterator.next()).value?.byteLength).toBe(196608);await iterator.return(undefined);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({closed:true,outputFrames:1});
}));
it('rejects pin drift and pre-abort before spawning',async()=>{
  let count=0;const base={ffmpegPath:executable,ffmpegSha256:'0'.repeat(64),args:[],size:2,timeoutMs:1000,onSpawn:()=>{count++;}};
  await expect(rgb8CubePlanePipeV1(base).next()).rejects.toThrow('版本');const c=new AbortController();c.abort();await expect(rgb8CubePlanePipeV1({...base,signal:c.signal}).next()).rejects.toThrow();expect(count).toBe(0);
});
it.each(['short','long','exit','stderr'])('rejects %s native output with a closed terminal receipt',async mode=>fixture(mode,async path=>{
  const receipts:Rgb8PlanePipeReceiptV1[]=[];const collect=async()=>{for await(const _ of tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:2,timeoutMs:5000,onReceipt:r=>{receipts.push(r);}})){};};
  await expect(collect()).rejects.toThrow();expect(receipts).toHaveLength(1);expect(receipts[0].closed).toBe(true);if(mode==='exit')expect(receipts[0].code).toBe(7);expect(Buffer.byteLength(receipts[0].stderr)).toBeLessThanOrEqual(131072);
}));
it('abort during a stalled child settles only after its close',async()=>fixture('stall',async path=>{
  const c=new AbortController(),receipts:Rgb8PlanePipeReceiptV1[]=[];const iterator=tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:256,blueIndices:[132,133],timeoutMs:5000,signal:c.signal,onSpawn:()=>{c.abort();},onReceipt:r=>{receipts.push(r);}});
  await expect(iterator.next()).rejects.toThrow();expect(receipts).toHaveLength(1);expect(receipts[0].closed).toBe(true);
}));
it('receipt callback failures do not digest twice or re-emit the receipt',async()=>fixture('echo',async path=>{
  let count=0;const collect=async()=>{for await(const _ of tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:2,timeoutMs:5000,onReceipt:()=>{count++;throw Error('receipt callback sentinel');}})){};};
  await expect(collect()).rejects.toThrow('receipt callback sentinel');expect(count).toBe(1);
}));
it('timeout closes a stalled child before rejection',async()=>fixture('stall',async path=>{
  const receipts:Rgb8PlanePipeReceiptV1[]=[];await expect(tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:2,timeoutMs:500,onReceipt:r=>{receipts.push(r);}}).next()).rejects.toThrow('逾時');expect(receipts).toHaveLength(1);expect(receipts[0].closed).toBe(true);
}));
it('spawn callback failure terminates only the launched child',async()=>fixture('stall',async path=>{
  const receipts:Rgb8PlanePipeReceiptV1[]=[];await expect(tracked({ffmpegPath:executable,ffmpegSha256:await hash(),args:[path],size:2,timeoutMs:5000,onSpawn:()=>{throw Error('spawn sentinel');},onReceipt:r=>{receipts.push(r);}}).next()).rejects.toThrow();expect(receipts).toHaveLength(1);expect(receipts[0].closed).toBe(true);
}));
