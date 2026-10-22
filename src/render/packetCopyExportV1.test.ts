import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { renderPacketCopyProjectV1, type PacketCopyDependenciesV1, type PacketCopyRuntimeV1 } from "./packetCopyExportV1";
import { sourcePreservingFixtureV1, sourcePreservingProbeFixtureV1 } from "./sourcePreservingV1.fixture";
import { packetCopyProbeFixtureV1 } from "./packetCopyV1.fixture";
const roots: string[] = [], sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) { if (await realpath(root) !== resolve(root)) throw Error("TEST_ROOT_CHANGED"); await rm(root, { recursive:true }); } });
async function fixture() {
  const root=await mkdtemp(join(process.env.TEMP??tmpdir(),"owned-packet-copy-control-"));roots.push(root);
  const source=join(root,"source.mp4"),output=join(root,"out.mp4"),parts=Array.from({length:60},(_,i)=>{const b=Buffer.alloc(7,i);b.writeUInt32BE(3);b[4]=i%30?1:5;return b;});
  const bytes=Buffer.concat(parts),selected=Buffer.concat(parts.slice(30,45));await writeFile(source,bytes);
  const project=sourcePreservingFixtureV1(source);project.tracks[0].clips[0].sourceStart=1;project.tracks[0].clips[0].duration=.5;
  const runtime:PacketCopyRuntimeV1={assetBase:root,ffmpegPath:join(root,"ffmpeg.exe"),ffprobePath:join(root,"ffprobe.exe"),expectedSourceSha256:sha(bytes),policy:"copy_exact_idr_video_window",timeoutMs:10000};
  const run:PacketCopyDependenciesV1['run']=vi.fn(async(exe,args)=>{
    if(exe===runtime.ffprobePath){const metadata=packetCopyProbeFixtureV1();if(args.at(-1)!==source){metadata.format.duration="0.500000";metadata.streams[0].duration="0.500000";}return{stdout:JSON.stringify(metadata),stderr:""};}
    if(args.includes("copy"))await writeFile(args.at(-1)!,selected);
    return{stdout:"frame=15\nprogress=end\n",stderr:""};
  });
  const readPackets:PacketCopyDependenciesV1['readPackets']=vi.fn(async(_exe,path,consume,options)=>{
    const count=path===source?60:15,offset=path===source?0:30;
    for(let i=0;i<count;i++)await consume({pts:i*512,dts:i*512,duration:512,size:7,pos:i*7,key:(i+offset)%30===0});
    const receipt={pid:125,code:0,signal:null,closed:true,packets:count,stdoutHighWaterMark:65536,largestChunkBytes:100,maximumPendingConsumers:1 as const,stderrTail:""};options?.onTerminal?.(receipt);return receipt;
  });
  const dependencies:PacketCopyDependenciesV1={run,readPackets,volumeProbe:async path=>({key:path.toLowerCase().startsWith("c:")?"C":"D",root:path,availableBytes:80*1024**3})};
  return{root,source,output,bytes,selected,project,runtime,dependencies};
}
describe("exact packet-cut lifecycle doubles; real codec/frame evidence is separate",()=>{
 it("preserves selected packet bytes/timing and publishes only a new output; source/project stay exact",async()=>{
  const f=await fixture(),before=JSON.stringify(f.project),result=await renderPacketCopyProjectV1(f.project,f.output,f.runtime,f.dependencies);
  expect((await readFile(f.output)).equals(f.selected)).toBe(true);expect((await readFile(f.source)).equals(f.bytes)).toBe(true);expect(JSON.stringify(f.project)).toBe(before);
  expect(result.retained.retainedPackets).toBe(15);expect(result.requestedCutShiftTicks).toBe(0);expect(result.decodedVideoFrames).toBe(15);expect(result.pixelOrAudioEncodingPasses).toBe(0);expect(result.mediaStagingBytes).toBe(0);
  expect((await readdir(f.root)).sort()).toEqual(["out.mp4","source.mp4"]);
 });
 it("rejects a non-IDR requested start before remux and does not silently preserve earlier packets",async()=>{
  const f=await fixture();f.project.tracks[0].clips[0].sourceStart=1+1/30;
  await expect(renderPacketCopyProjectV1(f.project,f.output,f.runtime,f.dependencies)).rejects.toThrow("NOT_EXACT_IDR");
  expect((f.dependencies.run as ReturnType<typeof vi.fn>).mock.calls.some((c:any[])=>c[0]===f.runtime.ffmpegPath)).toBe(false);expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
 });
 it("existing output, source SHA, audio and unknown volume cannot overwrite/publish",async()=>{
  const f=await fixture();await writeFile(f.output,"OLD");await expect(renderPacketCopyProjectV1(f.project,f.output,f.runtime,f.dependencies)).rejects.toThrow("OUTPUT_EXISTS");expect(await readFile(f.output,"utf8")).toBe("OLD");
  await expect(renderPacketCopyProjectV1(f.project,join(f.root,"bad.mp4"),{...f.runtime,expectedSourceSha256:"0".repeat(64)},f.dependencies)).rejects.toThrow("SHA_MISMATCH");
  await expect(renderPacketCopyProjectV1(f.project,join(f.root,"audio.mp4"),f.runtime,{...f.dependencies,run:async()=>({stdout:JSON.stringify(sourcePreservingProbeFixtureV1()),stderr:""})})).rejects.toThrow("AUDIO_OR_OTHER_STREAM");
  await expect(renderPacketCopyProjectV1(f.project,join(f.root,"unknown.mp4"),f.runtime,{...f.dependencies,volumeProbe:async()=>undefined})).rejects.toThrow("SPACE_UNKNOWN");
  expect((await readdir(f.root)).sort()).toEqual(["out.mp4","source.mp4"]);
 });
 it("a substituted payload or decode frame count refuses and removes only the owned candidate",async()=>{
  const f=await fixture();const original=f.dependencies.run;
  await expect(renderPacketCopyProjectV1(f.project,f.output,f.runtime,{...f.dependencies,run:async(exe,args,...rest)=>{const result=await original(exe,args,...rest);if(args.includes("copy")){const changed=Buffer.from(f.selected);changed[6]^=1;await writeFile(args.at(-1)!,changed);}return result;}})).rejects.toThrow("PAYLOAD_OR_TIMELINE_CHANGED");
  await expect(renderPacketCopyProjectV1(f.project,f.output,f.runtime,{...f.dependencies,run:async(exe,args,...rest)=>args.includes("null")?{stdout:"frame=14\nprogress=end\n",stderr:""}:original(exe,args,...rest)})).rejects.toThrow("DECODE_COUNT_MISMATCH");
  expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
 });
 it("lease-time project/candidate changes and cancellation cannot publish",async()=>{
  const f=await fixture();await expect(renderPacketCopyProjectV1(f.project,f.output,{...f.runtime,withPublicationGuard:async operation=>{const name=(await readdir(f.root)).find(n=>n.endsWith(".packet-copy.part.mp4"))!;await writeFile(join(f.root,name),Buffer.alloc(f.selected.length));return operation();}},f.dependencies)).rejects.toThrow("CANDIDATE_CHANGED");
  await expect(renderPacketCopyProjectV1(f.project,f.output,{...f.runtime,withPublicationGuard:async operation=>{f.project.revision++;return operation();}},f.dependencies)).rejects.toThrow("PROJECT_CHANGED");
  const controller=new AbortController();controller.abort(Error("CONTROL_PRE_CANCEL"));await expect(renderPacketCopyProjectV1(f.project,f.output,{...f.runtime,signal:controller.signal},f.dependencies)).rejects.toThrow("CONTROL_PRE_CANCEL");
  expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
 });
});
