import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
const controls = vi.hoisted(() => ({ make: null as null | (() => unknown), calls: [] as unknown[] }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => { controls.calls.push(args); return controls.make!(); } }));
import { readAacPacketsV1, type AacPacketReaderReceiptV1 } from "./aacPacketReaderV1";
const line=(n:number)=>`pts=${(n-1)*1024}|dts=${(n-1)*1024}|duration=1024|size=7|pos=${n*7}|flags=${n?"K__":"KD_"}${n?"":"|side_datum/skip_samples:side_data_type=Skip Samples|side_datum/skip_samples:skip_samples=1024|side_datum/skip_samples:discard_padding=0|side_datum/skip_samples:skip_reason=0|side_datum/skip_samples:discard_reason=0"}\n`;
function child(data:string,code=0) {
  const proc=new EventEmitter() as EventEmitter & {pid:number;stdout:Readable;stderr:Readable;kill:ReturnType<typeof vi.fn>};proc.pid=125;
  proc.stdout=Readable.from([Buffer.from(data.slice(0,12)),Buffer.from(data.slice(12))]);proc.stderr=Readable.from([]);
  let closed=false;const close=()=>{if(!closed){closed=true;proc.emit("close",code,null);}};
  proc.stdout.on("end",()=>setImmediate(close));proc.kill=vi.fn(()=>{proc.stdout.destroy();setImmediate(close);return true;});return proc;
}
afterEach(()=>{controls.calls=[];controls.make=null;});
describe("AAC packet reader bounded lifetime and sequential consumer",()=>{
 it("consumes compact chunk boundaries and awaits each consumer with one outstanding callback",async()=>{
  const proc=child(line(0)+line(1)+line(2));controls.make=()=>proc;let pending=0,peak=0;const order:number[]=[];
  const receipt=await readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async p=>{pending++;peak=Math.max(peak,pending);await new Promise(r=>setTimeout(r,2));order.push(p.pts);pending--;});
  expect(order).toEqual([-1024,0,1024]);expect(peak).toBe(1);expect(receipt.closed).toBe(true);expect(receipt.packets).toBe(3);expect(receipt.largestChunkBytes).toBeLessThan(4096);expect(proc.kill).not.toHaveBeenCalled();
 });
 it("pre-cancellation launches no child and in-flight cancellation closes that owned producer",async()=>{
  const pre=new AbortController();pre.abort(Error('CONTROL_PRE_CANCEL'));
  await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{}, {signal:pre.signal})).rejects.toThrow('CONTROL_PRE_CANCEL');expect(controls.calls).toHaveLength(0);
  const proc=child(line(0)+line(1)),controller=new AbortController(),receipts:AacPacketReaderReceiptV1[]=[];controls.make=()=>proc;
  await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{controller.abort(Error('CONTROL_CANCEL'));},{signal:controller.signal,onTerminal:r=>receipts.push(r)})).rejects.toThrow('CONTROL_CANCEL');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
 it("malformed packet output and consumer failure cannot report a successful reader",async()=>{
  for(const input of ['x'.repeat(4097),line(0)]){const proc=child(input);controls.make=()=>proc;const receipts:AacPacketReaderReceiptV1[]=[];
   await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{throw Error('CONTROL_CONSUMER');},{onTerminal:r=>receipts.push(r)})).rejects.toThrow();
   expect(receipts[0].closed).toBe(true);expect(proc.kill).toHaveBeenCalled();}
 });
 it("nonzero child and empty output refuse even if stream observation itself ends",async()=>{
  controls.make=()=>child(line(0),1);await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{})).rejects.toThrow('READER_FAILED');
  controls.make=()=>child('');await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>{})).rejects.toThrow('READER_FAILED');
 });
 it("a stalled consumer cannot prevent the reader deadline from stopping its producer",async()=>{
  const proc=child(line(0));controls.make=()=>proc;const receipts:AacPacketReaderReceiptV1[]=[];
  await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>new Promise<void>(()=>{}),{timeoutMs:30,onTerminal:r=>receipts.push(r)})).rejects.toThrow('TIMED_OUT');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
 it("no-progress watchdog stops a producer before a longer total budget expires",async()=>{
  const proc=child(line(0));controls.make=()=>proc;const receipts:AacPacketReaderReceiptV1[]=[];
  await expect(readAacPacketsV1('D:/owned/ffprobe.exe','D:/owned/source.mp4',async()=>new Promise<void>(()=>{}),{timeoutMs:1000,stallMs:30,onTerminal:r=>receipts.push(r)})).rejects.toThrow('STALLED');
  expect(proc.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
});
