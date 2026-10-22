import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { openSourceClockIndexSessionV1, borrowSourceClockIndexSessionV1, sourceClockIndexLifetimeSignalV1, type SourceClockIndexSessionV1 } from "./sourceClockIndexSessionV1";
import { buildDecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { assertTimeRemapLocalPathV1 } from "./timeRemapCacheIdentityV1";
const controlled=vi.hoisted(()=>({foreign:""}));
vi.mock("./renderDiskSpace",async()=>{const actual=await vi.importActual<typeof import("./renderDiskSpace")>("./renderDiskSpace");return{...actual,
  probeVolumeSpace:vi.fn(async(path:string)=>{const r=await actual.probeVolumeSpace(path);return r&&path===controlled.foreign?{...r,key:"controlled-other-volume"}:r;})};});
vi.mock("./decodedPtsIndexV1",()=>({buildDecodedPtsIndexV1:vi.fn()}));
let root:string,source:string,ffmpeg:string,ffprobe:string,project:string,helper:string,allocatedParent:string,rootIdentity:{dev:number;ino:number};
const sessions:SourceClockIndexSessionV1[]=[];
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const profile={timeBase:{numerator:1,denominator:1000},h264FourByteNals:false,timeoutMs:1000};
beforeEach(async()=>{
  allocatedParent=resolve(tmpdir());root=await mkdtemp(join(allocatedParent,"editkin-index-session-test-"));rootIdentity=await lstat(root);source=join(root,"generated-source");ffmpeg=join(root,"ffmpeg-fixture");ffprobe=join(root,"ffprobe-fixture");project=join(root,"project");helper=join(root,"helper");
  await mkdir(project);await mkdir(helper);await writeFile(source,"fixture-source");await writeFile(ffmpeg,"fake tool executable identity only");await writeFile(ffprobe,"fake probe identity only");
  vi.stubEnv("TEMP",helper);vi.stubEnv("TMP",helper);controlled.foreign="";vi.mocked(buildDecodedPtsIndexV1).mockReset();
  vi.mocked(buildDecodedPtsIndexV1).mockImplementation(async input=>{
    await input.metadata.write(Buffer.alloc(72));await input.metadata.sync();const identity=await input.metadata.stat({bigint:true});
    return{index:{timing:"vfr",timeBase:input.timeBase,clockOrigin:{pts:0,sourceSeconds:0},decodedFrameCount:3,lastFrameEndPts:300,metadataBytes:72,metadataSha256:"a".repeat(64),ptsAt:i=>i*100,seekIndexAt:()=>0,
      assertIdentity:async()=>{const current=await input.metadata.stat({bigint:true});if(current.ino!==identity.ino||current.size!==identity.size||current.mtimeNs!==identity.mtimeNs||current.ctimeNs!==identity.ctimeNs)throw Error("PTS_INDEX_IDENTITY_CHANGED");},
      receipt:{pagesRead:0,cachedBytes:0,maximumCachedBytes:0,idrAnchors:0}},packetReceipts:[],frameReceipts:[{simulatedProtocolOnly:true}],metadataPixelsStaged:0};
  });
});
afterEach(async()=>{
  for(const s of sessions.splice(0))await s.close();vi.unstubAllEnvs();controlled.foreign="";
  // Only this test's exclusively created temporary root is retired.
  if(root){
    await assertTimeRemapLocalPathV1(root);const identity=await lstat(root);
    if(resolve(root)!==root||dirname(root)!==allocatedParent||!basename(root).startsWith("editkin-index-session-test-")||identity.dev!==rootIdentity.dev||identity.ino!==rootIdentity.ino)throw Error("OWNED_TEST_ROOT_CHANGED");
    await rm(root,{recursive:true,force:true});
  }
});
async function openSession(extra:Partial<Parameters<typeof openSourceClockIndexSessionV1>[0]>={}){
  const s=await openSourceClockIndexSessionV1({sourcePath:source,expectedSourceSha256:sha(await readFile(source)),ffmpegPath:ffmpeg,ffprobePath:ffprobe,projectRoot:project,helperTemporaryRoot:helper,timeoutMs:5000,...extra});sessions.push(s);return s;
}
async function borrow(s:SourceClockIndexSessionV1,extra:Partial<Parameters<typeof borrowSourceClockIndexSessionV1>[1]>={}){
  const {stat}=await import("node:fs/promises");return borrowSourceClockIndexSessionV1(s,{sourcePath:source,sourceIdentity:await stat(source,{bigint:true}),expectedSourceSha256:sha(await readFile(source)),ffmpegPath:ffmpeg,ffprobePath:ffprobe,outputParent:project,...extra});
}

describe("live held-source PTS index session, mocked index builder / real filesystem ownership",()=>{
  it("hashes the source once and builds the shared index once across serial window borrows",async()=>{
    const s=await openSession();expect(s.receipt).toMatchObject({sourceHashes:1,indexBuilds:0,borrows:0});
    const a=await borrow(s),first=await a.getIndex(profile);a.release();const b=await borrow(s),second=await b.getIndex(profile);b.release();
    expect(first.reusedIndex).toBe(false);expect(second.reusedIndex).toBe(true);expect(second.index).toBe(first.index);expect(second.frameReceipts).toEqual([]);
    expect(buildDecodedPtsIndexV1).toHaveBeenCalledTimes(1);expect(s.receipt).toMatchObject({sourceHashes:1,indexBuilds:1,metadataBytes:72,borrows:2});
    await s.close();expect(s.receipt.closed).toBe(true);expect((await readdir(join(project,".editkin/time-remap-v1"))).some(n=>n.startsWith(".index-session-"))).toBe(false);
    expect((await readFile(source)).toString()).toBe("fixture-source");
  });
  it("refuses a forged session and refuses close/reborrow while a real render holds its lease",async()=>{
    const s=await openSession(),a=await borrow(s);await expect(s.close()).rejects.toThrow("IN_USE");await expect(borrow(s)).rejects.toThrow("BUSY");
    await expect(borrow({...s})).rejects.toThrow("IDENTITY_REQUIRED");a.release();a.release();await s.close();await expect(borrow(s)).rejects.toThrow("IDENTITY_REQUIRED");
  });
  it("copies diagnostic receipts instead of admitting caller mutations as session state",async()=>{
    const s=await openSession(),receipt=s.receipt as {sourceHashes:number};receipt.sourceHashes=99;expect(s.receipt.sourceHashes).toBe(1);
  });
  it.each(["source","ffmpeg","ffprobe"] as const)("refuses changed %s before starting an index builder",async kind=>{
    const s=await openSession();await writeFile(kind==="source"?source:kind==="ffmpeg"?ffmpeg:ffprobe,"changed-fixture");
    await expect(borrow(s)).rejects.toThrow(kind==="source"?"BINDING_CHANGED":"SOURCE_OR_TOOL_CHANGED");expect(buildDecodedPtsIndexV1).not.toHaveBeenCalled();
  });
  it("rechecks source identity at publication after a successful index borrow",async()=>{
    const s=await openSession(),a=await borrow(s);await a.getIndex(profile);await writeFile(source,"changed after index");
    await expect(a.verify()).rejects.toThrow("SOURCE_OR_TOOL_CHANGED");a.release();
  });
  it("refuses mutated metadata and a changed probe timebase on index reuse",async()=>{
    const s=await openSession(),a=await borrow(s);await a.getIndex(profile);a.release();
    const b=await borrow(s);await expect(b.getIndex({...profile,timeBase:{numerator:1,denominator:90000}})).rejects.toThrow("PROFILE_CHANGED");b.release();
    const dirs=await readdir(join(project,".editkin/time-remap-v1")),work=dirs.find(n=>n.startsWith(".index-session-"))!;
    await writeFile(join(project,".editkin/time-remap-v1",work,"pts.bin"),Buffer.alloc(73));await expect(borrow(s)).rejects.toThrow("PTS_INDEX_IDENTITY_CHANGED");
  });
  it("keeps a failed index build terminal within that session, then cleans only owned files",async()=>{
    vi.mocked(buildDecodedPtsIndexV1).mockRejectedValueOnce(Error("controlled index failure"));
    const s=await openSession(),a=await borrow(s);await expect(a.getIndex(profile)).rejects.toThrow("controlled index failure");a.release();
    await expect(borrow(s)).rejects.toThrow("SESSION_FAILED");expect(buildDecodedPtsIndexV1).toHaveBeenCalledTimes(1);await s.close();
  });
  it("requires the same output volume and unchanged owned helper environment",async()=>{
    const s=await openSession();controlled.foreign=project;await expect(borrow(s)).rejects.toThrow("OUTPUT_PROJECT_VOLUME_REQUIRED");controlled.foreign="";
    vi.stubEnv("TMP",root);await expect(borrow(s)).rejects.toThrow("HELPER_ENV_CHANGED");
  });
  it("propagates either host abort signal to the window renderer",async()=>{
    const host=new AbortController(),window=new AbortController(),s=await openSession({signal:host.signal});
    const combined=sourceClockIndexLifetimeSignalV1(s,window.signal)!;window.abort();expect(combined.aborted).toBe(true);
    const hostOnly=sourceClockIndexLifetimeSignalV1(s);host.abort();expect(hostOnly?.aborted).toBe(true);
  });
  it("refuses invalid budgets or a wrong source hash before creating a session work directory",async()=>{
    await expect(openSession({maximumMetadataBytes:23})).rejects.toThrow("BUDGET_OR_SHA_INVALID");
    await expect(openSession({expectedSourceSha256:"0".repeat(64)})).rejects.toThrow("SOURCE_SHA_MISMATCH");expect(buildDecodedPtsIndexV1).not.toHaveBeenCalled();
  });
});
