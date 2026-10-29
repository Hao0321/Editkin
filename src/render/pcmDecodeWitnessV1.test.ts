import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
const control = vi.hoisted(() => ({ make:null as null | (() => unknown), calls:[] as any[] }));
vi.mock("node:child_process",()=>({spawn:(...args:any[])=>{control.calls.push(args);return control.make!();}}));
import { decodePcmWitnessV1, type PcmDecodeReceiptV1 } from "./pcmDecodeWitnessV1";
const runtime={executable:"D:/owned/ffmpeg.exe",source:"D:/owned/source.mp4",sampleRate:48000,channels:2,expectedSamples:4,timeoutMs:1000};
function child(chunks:Buffer[],code=0,stalled=false){const c=new EventEmitter()as EventEmitter&{pid:number;stdout:Readable;stderr:Readable;kill:ReturnType<typeof vi.fn>};c.pid=125;c.stdout=stalled?new Readable({read(){}}):Readable.from(chunks);c.stderr=Readable.from([]);let closed=false;const finish=()=>{if(!closed){closed=true;c.emit("close",code,null);}};c.stdout.on("end",()=>setImmediate(finish));c.kill=vi.fn(()=>{c.stdout.destroy();setImmediate(finish);return true;});return c;}
afterEach(()=>{control.calls=[];control.make=null;});
describe("bounded float PCM decoded witness lifecycle",()=>{
 it("hashes exact binary chunks despite split samples and creates no media file",async()=>{
  const bytes=Buffer.alloc(32,77),c=child([bytes.subarray(0,3),bytes.subarray(3,17),bytes.subarray(17)]);control.make=()=>c;
  const result=await decodePcmWitnessV1(runtime);expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));expect(result.samples).toBe(4);expect(result.bytes).toBe(32);expect(result.producer.closed).toBe(true);
  expect(control.calls[0][1].at(-1)).toBe("-");expect(control.calls[0][1]).not.toContain("-ar");expect(control.calls[0][1]).not.toContain("-ac");
 });
 it("reference trimming starts decode at source origin and never introduces a fast -ss",async()=>{
  control.make=()=>child([Buffer.alloc(32)]);await decodePcmWitnessV1({...runtime,referenceWindow:{startSample:5000000000,endSample:5000000004}});
  const args=control.calls[0][1];expect(args).not.toContain("-ss");expect(args).toContain("atrim=start_sample=5000000000:end_sample=5000000004,asetpts=PTS-STARTPTS");
 });
 it("rejects extra/short/partial audio and nonzero decode instead of hashing an arbitrary prefix",async()=>{
  for(const [bytes,code]of [[33,0],[31,0],[32,1]]as const){control.make=()=>child([Buffer.alloc(bytes)],code);await expect(decodePcmWitnessV1(runtime)).rejects.toThrow();}
 });
 it("pre-cancel launches nothing and no-progress stop closes the owned producer",async()=>{
  const controller=new AbortController();controller.abort(Error("CONTROL_PRE_CANCEL"));await expect(decodePcmWitnessV1({...runtime,signal:controller.signal})).rejects.toThrow("CONTROL_PRE_CANCEL");expect(control.calls).toHaveLength(0);
  const c=child([],0,true),receipts:PcmDecodeReceiptV1[]=[];control.make=()=>c;await expect(decodePcmWitnessV1({...runtime,stallMs:30,onTerminal:r=>receipts.push(r)})).rejects.toThrow("STALLED");expect(c.kill).toHaveBeenCalled();expect(receipts[0].closed).toBe(true);
 });
});
