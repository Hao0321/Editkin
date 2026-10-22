import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { prepareLongformWordRecognitionV1, readLongformWordArtifactV1, readLongformWordPageV1,
  readLongformWordIssuePageV1, type LongformWordRecognitionDepsV1 } from "./longformWordRecognitionV1";
import { MATERIAL_INTELLIGENCE_SCHEMA, readMaterialIntelligence, readMaterialKeyframe, recordMaterialSemantics,
  verifyMaterialSemanticsReceipt, type MaterialIntelligencePacket } from "./materialIntelligence";
import { hashMaterialJson, sealMaterialPacket, type MaterialCacheIdentity } from "./materialEvidenceCache";
import { colorDigest } from "./materialColorSamplingRuntime";
import { materialColorRequestSnapshot } from "./materialColorSamplingValidation";
import type { MaterialColorReceipt, MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";
import { prepareLongformSentenceAlignmentV1, readLongformSentenceAlignmentArtifactV1, readLongformSentenceAlignmentPageV1,
  type LongformSentenceAlignmentDepsV1, type LongformSentenceAlignmentRuntimeV1 } from "./longformSentenceAlignmentRuntimeV1";

const owned:string[]=[];
afterEach(async()=>{
  for(const root of owned.splice(0)){
    const inside=relative(tmpdir(),root);assert(inside&&!inside.startsWith("..")&&!isAbsolute(inside));
    await rm(root,{recursive:true,force:true});
  }
});
const simulatedRecognition=(shift:number)=>JSON.stringify({transcription:[{text:" Click save. Open menu.",offsets:{from:0,to:5000},
  tokens:[[" Click",400,700],[" save.",800,1200],[" Open",2100,2400],[" menu.",2500,3200]].map(([text,start,end],id)=>({
    text,id,p:.9,offsets:{from:Number(start)+shift,to:Number(end)+shift}}))}]});
async function fixture(audio=true){
  const root=await mkdtemp(join(tmpdir(),"longform-alignment-runtime-"));owned.push(root);
  for(const name of["voice.wav","screen.mp4"])await writeFile(join(root,name),name);
  await writeFile(join(root,"script.txt"),"Click save.\n\nOpen menu.");
  const runtime:LongformSentenceAlignmentRuntimeV1={sourceRoot:root,cacheRoot:join(root,"cache"),workRoot:join(root,"work"),
    ffmpegPath:join(root,"ffmpeg.exe"),whisperCliPath:join(root,"whisper.exe"),modelPath:join(root,"model.bin"),modelRoot:root,
    probe:async path=>({duration:60,width:1920,height:1080,hasVideo:true,hasAudio:audio||!path.endsWith("screen.mp4")})};
  const calls:string[][]=[],prepared:unknown[]=[];
  const wordDeps:LongformWordRecognitionDepsV1={inspectModel:async()=>({valid:true,bytes:PINNED_WHISPER_MODEL.bytes,sha256:PINNED_WHISPER_MODEL.sha256}),
    runtimeIdentity:async()=>"a".repeat(64),run:async(exe,args,options)=>{
      options.signal?.throwIfAborted();calls.push([exe,...args]);
      if(args[0]==="--help")return{stdout:Buffer.from("--output-json-full"),stderr:""};
      if(exe===runtime.ffmpegPath)await writeFile(args.at(-1)!,args[args.indexOf("-i")+1]);
      else{
        const source=await readFile(args[args.indexOf("-f")+1],"utf8"),prefix=args[args.indexOf("-of")+1];
        await writeFile(prefix+".json",simulatedRecognition(source.endsWith("voice.wav")?0:1000));
      }
      return{stdout:Buffer.alloc(0),stderr:""};
    }};
  const voiceRequest={schema:"editkin.longform-word-timing-request/v1",narration:{id:"voice",path:"voice.wav",sourceStart:7,duration:5},
    script:{kind:"file",path:"script.txt"},recordings:[{id:"screen",path:"screen.mp4",sourceStart:20,duration:10}],screenshots:[],language:"en"};
  const voice=await prepareLongformWordRecognitionV1(voiceRequest,{...runtime,onProgress:undefined},wordDeps);
  const deps:LongformSentenceAlignmentDepsV1={readWords:readLongformWordArtifactV1,wordPage:readLongformWordPageV1,
    issuePage:readLongformWordIssuePageV1,readMaterial:readMaterialIntelligence,verifySemantics:verifyMaterialSemanticsReceipt,
    readFrame:readMaterialKeyframe,prepareWords:async(raw,current)=>{
      prepared.push(raw);return prepareLongformWordRecognitionV1(raw,current,wordDeps);
    }};
  const request={schema:"editkin.longform-sentence-alignment-request/v1",narrationArtifactId:voice.artifact.artifactId};
  return{root,runtime,wordDeps,voiceRequest,voice,deps,request,calls,prepared};
}
async function published(root:string){
  try{return await readdir(join(root,"cache/longform-sentence-alignment-v1"));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}
}
it("recognizes audio recordings through the word pipeline and preserves narration and actual source ranges",async()=>{
  const f=await fixture(),progress:string[]=[];f.runtime.onProgress=value=>{progress.push(value.phase);};
  const result=await prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps),draft=result.artifact.draft;
  expect(f.prepared).toEqual([expect.objectContaining({narration:expect.objectContaining({id:"screen",path:join(f.root,"screen.mp4"),
    sourceStart:20,duration:10,expectedSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}),recordings:[],language:"en"})]);
  expect(draft.sentences.map(row=>row.clock)).toEqual([{start:.4,end:1.2,authority:"recognizer_words"},{start:2.1,end:3.2,authority:"recognizer_words"}]);
  expect(draft.sentences.map(row=>[row.recordingCandidates[0].sourceStart,row.recordingCandidates[0].sourceEnd])).toEqual([[21.4,22.2],[23.1,24.2]]);
  expect(draft.narration).toEqual({sourceStart:7,duration:5,preservedDuration:5,removedDuration:0});
  expect(draft.syntheticTimingUsed).toBe(false);expect(draft.projectModified).toBe(false);expect(draft.contentVerified).toBe(false);
  expect(progress).toContain("recording_words");expect(progress.slice(-2)).toEqual(["aligning","finalizing"]);
  expect(await readdir(f.runtime.workRoot)).toEqual([]);expect(await readFile(join(f.root,"screen.mp4"),"utf8")).toBe("screen.mp4");
});
it("reuses recording windows and pages all sentences and chapters with stable artifact identity",async()=>{
  const f=await fixture(),first=await prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps);
  const recognized=f.calls.filter(row=>row.includes("-ojf")).length;
  const repeated=await prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps);
  expect(repeated.artifact).toEqual(first.artifact);expect(repeated.cachedRecordingWindows).toBe(1);
  expect(f.calls.filter(row=>row.includes("-ojf"))).toHaveLength(recognized);
  const page=await readLongformSentenceAlignmentPageV1(f.runtime,first.artifact.artifactId,"sentences",0,1,f.deps);
  expect(page.total).toBe(2);expect(page.items[0]).toMatchObject({text:"Click save."});expect(page.nextOffset).toBe(1);
  const last=await readLongformSentenceAlignmentPageV1(f.runtime,first.artifact.artifactId,"sentences",page.nextOffset!,1,f.deps);
  expect(last.items[0]).toMatchObject({text:"Open menu."});expect(last.nextOffset).toBeNull();
  const chapters=await readLongformSentenceAlignmentPageV1(f.runtime,first.artifact.artifactId,"chapters",0,200,f.deps);
  expect(chapters.items).toMatchObject([{title:"Click save.",start:.4,end:1.2},{title:"Open menu.",start:2.1,end:3.2}]);
  await expect(readLongformSentenceAlignmentPageV1(f.runtime,first.artifact.artifactId,"sentences",0,201,f.deps)).rejects.toThrow("LONGFORM_ALIGNMENT_PAGE");
});
it("retains silent recordings as unavailable evidence without inventing visual observations",async()=>{
  const f=await fixture(false),result=await prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps);
  expect(f.prepared).toEqual([]);expect(result.artifact.recordingReferences).toEqual([{recordingId:"screen",kind:"unavailable",reason:"NO_AUDIO_OR_PREPARED_EVIDENCE"}]);
  expect(result.artifact.draft.sentences.every(row=>row.recordingCandidates.length===0)).toBe(true);
  expect(result.artifact.draft.narration.preservedDuration).toBe(5);
});
it("refuses unknown recording and chapter IDs before starting recording recognition",async()=>{
  const f=await fixture();
  await expect(prepareLongformSentenceAlignmentV1({...f.request,recordingEvidence:[{kind:"word_timing",recordingId:"other",artifactId:f.voice.artifact.artifactId}]},f.runtime,f.deps))
    .rejects.toThrow("LONGFORM_ALIGNMENT_RECORDING_ID");
  await expect(prepareLongformSentenceAlignmentV1({...f.request,chapterTitles:[{paragraphId:"other",title:"Wrong chapter"}]},f.runtime,f.deps))
    .rejects.toThrow("LONGFORM_ALIGNMENT_CHAPTER_ID");
  await expect(prepareLongformSentenceAlignmentV1({...f.request,model:"another-model"},f.runtime,f.deps)).rejects.toThrow();
  expect(f.prepared).toEqual([]);expect(await published(f.root)).toEqual([]);
});
it("rejects supplied word evidence belonging to another source or another recording range",async()=>{
  const f=await fixture(),request=(artifactId:string)=>({...f.request,recordingEvidence:[{kind:"word_timing",recordingId:"screen",artifactId}]});
  await expect(prepareLongformSentenceAlignmentV1(request(f.voice.artifact.artifactId),f.runtime,f.deps)).rejects.toThrow("LONGFORM_ALIGNMENT_RECORDING_BINDING");
  const shorter=await prepareLongformWordRecognitionV1({...f.voiceRequest,narration:{id:"screen",path:"screen.mp4",sourceStart:20,duration:9},recordings:[]},{...f.runtime,onProgress:undefined},f.wordDeps);
  await expect(prepareLongformSentenceAlignmentV1(request(shorter.artifact.artifactId),f.runtime,f.deps)).rejects.toThrow("LONGFORM_ALIGNMENT_RECORDING_BINDING");
  expect(f.prepared).toEqual([]);expect(await published(f.root)).toEqual([]);
});
it("rejects an identically hashed recording at a different path",async()=>{
  const f=await fixture();await writeFile(join(f.root,"other.mp4"),await readFile(join(f.root,"screen.mp4")));
  const other=await prepareLongformWordRecognitionV1({...f.voiceRequest,narration:{id:"other",path:"other.mp4",sourceStart:20,duration:10},recordings:[]},{...f.runtime,onProgress:undefined},f.wordDeps);
  await expect(prepareLongformSentenceAlignmentV1({...f.request,recordingEvidence:[{kind:"word_timing",recordingId:"screen",artifactId:other.artifact.artifactId}]},f.runtime,f.deps))
    .rejects.toThrow("LONGFORM_ALIGNMENT_RECORDING_PATH");
  expect(await published(f.root)).toEqual([]);
});
it("rechecks the author's script after alignment before publishing any draft",async()=>{
  const f=await fixture();f.runtime.onProgress=async value=>{if(value.phase==="finalizing")await writeFile(join(f.root,"script.txt"),"author revision");};
  await expect(prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps)).rejects.toThrow("LONGFORM_SCRIPT_CHANGED");
  expect(await published(f.root)).toEqual([]);expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("rechecks primary raw recognition evidence before publishing the computed draft",async()=>{
  const f=await fixture();f.runtime.onProgress=async value=>{
    if(value.phase==="finalizing")await writeFile(join(f.runtime.cacheRoot,"longform-word-timing-v1/windows",f.voice.artifact.windows[0].rawFile),"substituted primary words");
  };
  await expect(prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps)).rejects.toThrow("WORD_TIMING_WINDOW_CACHE_SHA");
  expect(await published(f.root)).toEqual([]);
});
it("propagates recording recognition cancellation and cleans only its owned temporary work",async()=>{
  const f=await fixture(),stop=new AbortController(),run=f.wordDeps.run;f.runtime.signal=stop.signal;
  f.wordDeps.run=async(...args)=>{if(args[1].includes("-ojf")){stop.abort();stop.signal.throwIfAborted();}return run(...args);};
  await expect(prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps)).rejects.toMatchObject({name:"AbortError"});
  expect(await published(f.root)).toEqual([]);expect(await readdir(f.runtime.workRoot)).toEqual([]);
  expect(await readFile(join(f.root,"voice.wav"),"utf8")).toBe("voice.wav");expect(await readFile(join(f.root,"screen.mp4"),"utf8")).toBe("screen.mp4");
});
it("rejects tampered saved drafts and later source or primary raw evidence changes",async()=>{
  const f=await fixture(),result=await prepareLongformSentenceAlignmentV1(f.request,f.runtime,f.deps),id=result.artifact.artifactId;
  const path=join(f.runtime.cacheRoot,"longform-sentence-alignment-v1",id+".json"),original=await readFile(path);
  const modified=JSON.parse(original.toString("utf8"));modified.draft.sentences[0].clock.start=999;await writeFile(path,JSON.stringify(modified));
  await expect(readLongformSentenceAlignmentArtifactV1(f.runtime,id,f.deps)).rejects.toThrow("LONGFORM_ALIGNMENT_ARTIFACT_SHA");
  await writeFile(path,original);const screen=await readFile(join(f.root,"screen.mp4"));await writeFile(join(f.root,"screen.mp4"),"author revision");
  await expect(readLongformSentenceAlignmentArtifactV1(f.runtime,id,f.deps)).rejects.toThrow("LONGFORM_SOURCE_CHANGED");
  await writeFile(join(f.root,"screen.mp4"),screen);
  await writeFile(join(f.runtime.cacheRoot,"longform-word-timing-v1/windows",f.voice.artifact.windows[0].rawFile),"substituted primary words");
  await expect(readLongformSentenceAlignmentArtifactV1(f.runtime,id,f.deps)).rejects.toThrow("WORD_TIMING_WINDOW_CACHE_SHA");
});

/** Synthetic revision-3 material guards exercise cache binding. These bytes
 * are deliberately unmeasured and are never a decoded visual truth claim. */
async function material(f:Awaited<ReturnType<typeof fixture>>,sourceStart=20){
  const source=f.voice.artifact.intake.materials.find(row=>row.kind==="recording")!,duration=10;
  const runtimeBody={schema:"editkin.material-color-runtime/v1"as const,status:"unmeasured"as const,
    reason:"synthetic-source-only-fixture",tools:[],implementations:[]};
  const colorRuntime:MaterialColorRuntimeIdentity={...runtimeBody,identitySha256:colorDigest(runtimeBody)},sample={id:"kf-1",time:0,sceneIndex:0};
  const colorBody:Omit<Extract<MaterialColorReceipt,{status:"unmeasured"|"not_applicable"}>,"receiptSha256">={
    schema:"editkin.material-color-receipt/v1",status:"unmeasured",reason:"synthetic-source-only-fixture",identity:colorRuntime,
    request:materialColorRequestSnapshot({sourcePath:source.path,sourceSha256:source.sha256,sourceStart,duration,kind:"video",samples:[sample],
      sceneCount:1,sceneCountVerified:true,sceneCuts:[]}),source:{sha256:source.sha256,start:sourceStart,duration},
    coverage:{requestedCount:1,sampledCount:0,sceneCount:1,sceneCountVerified:true,sceneAttributionVerified:true,sceneCuts:[],sampledSceneIndices:[],omittedSceneIndices:[0]},mapping:[]};
  const identity:MaterialCacheIdentity={schema:MATERIAL_INTELLIGENCE_SCHEMA,engineRevision:3,assetId:"screen",clipId:"screen",sourceSha256:source.sha256,
    sourceStart,duration,fps:30,kind:"video",language:"en",includeTranscript:true,maxKeyframes:1,colorRuntime,preparationSha256:"a".repeat(64)};
  const materialId=hashMaterialJson(identity),frame=Buffer.from([0xff,0xd8,0xff,0xd9]);
  const packet:MaterialIntelligencePacket=sealMaterialPacket({schema:MATERIAL_INTELLIGENCE_SCHEMA,materialId,
    source:{assetId:"screen",clipId:"screen",sourceSha256:source.sha256,sourceStart,duration,fps:30,kind:"video",hasAudio:true},
    analysis:{scene:{state:"ready",cuts:[]},transcript:{state:"ready",cueCount:1,cues:[{start:1.4,end:2.2,text:"Click save."}]},
      color:{...colorBody,receiptSha256:colorDigest(colorBody)}},
    keyframes:[{...sample,sha256:createHash("sha256").update(frame).digest("hex"),bytes:frame.length,mimeType:"image/jpeg",fileName:"frame-01.jpg"}],
    createdAt:"2026-10-12T00:00:00.000Z"},identity);
  const directory=join(f.runtime.cacheRoot,"material-intelligence",materialId);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,"manifest.json"),JSON.stringify(packet));await writeFile(join(directory,"frame-01.jpg"),frame);
  const semantic=await recordMaterialSemantics(f.runtime.cacheRoot,{materialId,sourceSha256:source.sha256,overallTopic:"Synthetic cache binding fixture",
    contentType:"test",language:"en",people:[],locations:[],segments:[{start:3.1,end:4.2,summary:"Open menu.",subjects:[],actions:[],objects:[],
      importance:.5,evidenceFrameIds:["kf-1"],transcriptCueIndexes:[]}]});
  const request={...f.request,recordingEvidence:[{kind:"material",recordingId:"screen",materialId,semanticReceiptSha256:semantic.semanticReceiptSha256}]};
  return{materialId,packet,directory,request};
}
it("reads sealed recording cues and referenced semantic frames with explicit proposal authority",async()=>{
  const f=await fixture(),m=await material(f),result=await prepareLongformSentenceAlignmentV1(m.request,f.runtime,f.deps);
  expect(f.prepared).toEqual([]);const sentences=result.artifact.draft.sentences;
  expect(sentences[0].recordingCandidates[0]).toMatchObject({sourceStart:21.4,sourceEnd:22.2,authority:"recognizer_cues",cueIndexes:[0],contentVerified:false});
  expect(sentences[1].recordingCandidates[0]).toMatchObject({sourceStart:23.1,sourceEnd:24.2,authority:"evidence_linked_semantics",evidenceFrameIds:["kf-1"],contentVerified:false});
  expect(sentences[1].preferredCandidateId).toBeUndefined();
  expect(await readLongformSentenceAlignmentArtifactV1(f.runtime,result.artifact.artifactId,f.deps)).toEqual(result.artifact);
});
it("rejects altered material seals and a valid sealed source range outside the caller's recording",async()=>{
  const f=await fixture(),m=await material(f);m.packet.analysis.transcript.cues[0].text="substituted cue";
  await writeFile(join(m.directory,"manifest.json"),JSON.stringify(m.packet));
  await expect(prepareLongformSentenceAlignmentV1(m.request,f.runtime,f.deps)).rejects.toThrow("素材 cache 完整性驗證失敗");
  const outside=await material(f,21);
  await expect(prepareLongformSentenceAlignmentV1(outside.request,f.runtime,f.deps)).rejects.toThrow("LONGFORM_ALIGNMENT_RECORDING_BINDING");
  expect(await published(f.root)).toEqual([]);
});
it("refuses a saved semantic proposal after its actual referenced frame bytes change",async()=>{
  const f=await fixture(),m=await material(f),result=await prepareLongformSentenceAlignmentV1(m.request,f.runtime,f.deps);
  await writeFile(join(m.directory,"frame-01.jpg"),"different frame bytes");
  await expect(readLongformSentenceAlignmentArtifactV1(f.runtime,result.artifact.artifactId,f.deps)).rejects.toThrow("關鍵幀完整性驗證失敗：kf-1");
});
