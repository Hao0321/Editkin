import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
const controls = vi.hoisted(() => ({ make: null as null | (() => unknown), calls: [] as unknown[] }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => { controls.calls.push(args); return controls.make!(); } }));
import { readDecodedFrameClocksV1, type DecodedFrameReaderReceiptV1 } from "./decodedFrameClockReaderV1";
const line=(n:number)=>`pts=${n*512}|best_effort_timestamp=${n*512}|duration=512\n`;
function child(data:string,code=0) {
  const proc=new EventEmitter() as EventEmitter & {pid:number;stdout:Readable;stderr:Readable;kill:ReturnType<typeof vi.fn>};proc.pid=125;
  proc.stdout=Readable.from([Buffer.from(data.slice(0,12)),Buffer.from(data.slice(12))]);proc.stderr=Readable.from([]);
  let closed=false;const close=()=>{if(!closed){closed=true;proc.emit("close",code,null);}};
  proc.stdout.on("end",()=>setImmediate(close));proc.kill=vi.fn(()=>{proc.stdout.destroy();setImmediate(close);return true;});return proc;
}
afterEach(()=>{controls.calls=[];controls.make=null;});
describe("decoded frame clock reader bounded lifetime and sequential consumer",()=>{
 it("consumes compact chunk boundaries and awaits each consumer with one outstanding callback",async()=>{
  const proc=child(line(0)+line(1)+line(2));controls.make=()=>proc;let pending=0,peak=0;const order:number[]=[];
  const receipt=await readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async p=>{pending++;peak=Math.max(peak,pending);await new Promise(r=>setTimeout(r,2));order.push(p.pts);pending--;});
  expect(order).toEqual([0,512,1024]);expect(peak).toBe(1);expect(receipt.closed).toBe(true);expect(receipt.frames).toBe(3);expect(receipt.largestChunkBytes).toBeLessThan(4096);expect(proc.kill).not.toHaveBeenCalled();
 });
 it("pre-cancellation launches no child and in-flight cancellation closes that owned producer",async()=>{
  const pre=new AbortController();pre.abort(Error('CONTROL_PRE_CANCEL'));
  await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{}, {signal:pre.signal})).rejects.toThrow('CONTROL_PRE_CANCEL');expect(controls.calls).toHaveLength(0);
  const proc=child(line(0)+line(1)),controller=new AbortController(),receipts:DecodedFrameReaderReceiptV1[]=[];controls.make=()=>proc;
  await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{controller.abort(Error('CONTROL_CANCEL'));},{signal:controller.signal,onTerminal:r=>receipts.push(r)})).rejects.toThrow('CONTROL_CANCEL');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
 it("malformed packet output and consumer failure cannot report a successful reader",async()=>{
  for(const input of ['x'.repeat(4097),line(0)]){const proc=child(input);controls.make=()=>proc;const receipts:DecodedFrameReaderReceiptV1[]=[];
   await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{throw Error('CONTROL_CONSUMER');},{onTerminal:r=>receipts.push(r)})).rejects.toThrow();
   expect(receipts[0].closed).toBe(true);expect(proc.kill).toHaveBeenCalled();}
 });
 it("nonzero child and empty output refuse even if stream observation itself ends",async()=>{
  controls.make=()=>child(line(0),1);await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{})).rejects.toThrow('READER_FAILED');
  controls.make=()=>child('');await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{})).rejects.toThrow('READER_FAILED');
 });
 it("a stalled consumer cannot prevent the reader deadline from stopping its producer",async()=>{
  const proc=child(line(0));controls.make=()=>proc;const receipts:DecodedFrameReaderReceiptV1[]=[];
  await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>new Promise<void>(()=>{}),{timeoutMs:30,onTerminal:r=>receipts.push(r)})).rejects.toThrow('TIMED_OUT');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
 it("no-progress watchdog stops a producer before a longer total budget expires",async()=>{
  const proc=child(line(0));controls.make=()=>proc;const receipts:DecodedFrameReaderReceiptV1[]=[];
  await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>new Promise<void>(()=>{}),{timeoutMs:1000,stallMs:30,onTerminal:r=>receipts.push(r)})).rejects.toThrow('STALLED');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
 it("decoder error diagnostics refuse even when the ffprobe child exits0",async()=>{
  const proc=child(line(0));proc.stderr=Readable.from([Buffer.from("decode corrupt frame")]);controls.make=()=>proc;
  await expect(readDecodedFrameClocksV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{})).rejects.toThrow('DECODE_ERROR');
 });

});
