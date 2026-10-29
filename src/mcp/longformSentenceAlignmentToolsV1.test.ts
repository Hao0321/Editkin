import type { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { LONGFORM_ALIGNMENT_RESPONSE_BYTES_V1, LONGFORM_SENTENCE_ALIGNMENT_TOOLS_V1, registerLongformSentenceAlignmentToolsV1,
  type LongformSentenceToolDepsV1 } from "./longformSentenceAlignmentToolsV1";

const jobId="la-"+"a".repeat(24),artifactId="b".repeat(64),request={schema:"editkin.longform-sentence-alignment-request/v1",narrationArtifactId:artifactId};
const job={jobId,state:"RUNNING"as const,startedAt:"2026-10-12T00:00:00Z",progress:{phase:"loading"as const,completedRecordings:0,totalRecordings:null}};
function fixture(){
  const registered=new Map<string,{config:{inputSchema:{parse:(value:unknown)=>unknown};description:string};
    handler:(value:never)=>Promise<{content:Array<{text:string}>;isError?:boolean}>}>();
  const server={registerTool:vi.fn((name,config,handler)=>registered.set(name,{config,handler}))}as unknown as McpServer;
  const deps:LongformSentenceToolDepsV1={jobs:{start:vi.fn(()=>job),get:vi.fn(()=>job),cancel:vi.fn(()=>({...job,state:"CANCELLING"as const}))},
    page:vi.fn(async(_runtime,_id,kind)=>({artifactId,state:"REVIEW_REQUIRED"as const,kind,total:0,offset:0,items:[],nextOffset:null,
      narration:{sourceStart:1,duration:150,preservedDuration:150,removedDuration:0 as const},contentVerified:false,syntheticTimingUsed:false,projectModified:false}))};
  registerLongformSentenceAlignmentToolsV1(server,{EDITKIN_WORKSPACE:"D:/owned",APPDATA:"C:/owned-appdata"},deps);
  const call=async(name:string,input:unknown)=>{const entry=registered.get(name)!;return entry.handler(entry.config.inputSchema.parse(input)as never);};
  return{registered,deps,call};
}
const value=(response:{content:Array<{text:string}>})=>JSON.parse(response.content[0].text);
it("registers alignment lifecycle and separate sentence and chapter pages with review semantics",async()=>{
  const f=fixture();expect([...f.registered.keys()]).toEqual([...LONGFORM_SENTENCE_ALIGNMENT_TOOLS_V1]);
  expect(value(await f.call("start_longform_sentence_alignment",request))).toMatchObject({jobId,state:"RUNNING"});
  expect(f.deps.jobs.start).toHaveBeenCalledWith({...request,recordingEvidence:[],chapterTitles:[]});
  expect(value(await f.call("get_longform_sentence_alignment_job",{jobId}))).toMatchObject({state:"RUNNING"});
  expect(value(await f.call("cancel_longform_sentence_alignment_job",{jobId}))).toMatchObject({state:"CANCELLING"});
  expect(f.registered.get("start_longform_sentence_alignment")!.config.description).toMatch(/保留完整旁白/);
});
it("uses bounded pages, strict IDs and the environment-owned source root",async()=>{
  const f=fixture();await f.call("read_longform_sentences",{artifactId});await f.call("read_longform_chapters",{artifactId,offset:12,limit:20});
  expect(f.deps.page).toHaveBeenCalledWith(expect.objectContaining({sourceRoot:"D:\\owned"}),artifactId,"sentences",0,100);
  expect(f.deps.page).toHaveBeenCalledWith(expect.objectContaining({sourceRoot:"D:\\owned"}),artifactId,"chapters",12,20);
  await expect(f.call("read_longform_sentences",{artifactId,limit:201})).rejects.toThrow();
  await expect(f.call("read_longform_chapters",{artifactId:"../escape"})).rejects.toThrow();
  await expect(f.call("start_longform_sentence_alignment",{...request,model:"medium"})).rejects.toThrow();
});
it("returns source errors and refuses oversized sentence text before an MCP response is sent",async()=>{
  const f=fixture();f.deps.page=async()=>{throw new Error("LONGFORM_SOURCE_CHANGED");};
  const changed=await f.call("read_longform_sentences",{artifactId});expect(changed.isError).toBe(true);expect(value(changed).error).toBe("LONGFORM_SOURCE_CHANGED");
  const page=await fixture().deps.page({sourceRoot:"D:/owned",cacheRoot:"D:/owned",workRoot:"D:/owned",ffmpegPath:"ffmpeg",
    whisperCliPath:"whisper",modelPath:"model",modelRoot:"D:/owned"},artifactId,"sentences");
  f.deps.page=async()=>({...page,items:[{id:"s1",paragraphId:"p1",sentenceIndex:0,text:"x".repeat(LONGFORM_ALIGNMENT_RESPONSE_BYTES_V1),
    sourceCharacterStart:0,sourceCharacterEnd:1,alignment:"UNALIGNED",coverage:0,wordIndexes:[],flags:[],recordingCandidates:[]}]});
  const huge=await f.call("read_longform_sentences",{artifactId});expect(huge.isError).toBe(true);
  expect(value(huge).error).toMatch(/LONGFORM_ALIGNMENT_RESPONSE_BUDGET/);expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(1000);
});
