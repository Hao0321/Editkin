import { expect, it } from "vitest";
import { alignLongformSentencesV1, type LongformSentenceAlignmentInputV1 } from "./longformSentenceAlignmentV1";
import { longformSentenceAlignmentRequestV1Schema } from "../domain/longformSentenceAlignmentV1";
import type { LongformTimedWordV1 } from "../domain/longformWordTimingV1";

const word=(text:string,start:number,end:number):LongformTimedWordV1=>({text,start,end,confidence:.9,windowIndex:0,segmentIndex:0,
  characterStart:0,characterEnd:text.length,tokenIndices:[0],sharedTokenRange:false});
const words=[word("Click",.4,.7),word("save",.8,1.2),word("Open",2.1,2.4),word("menu",2.5,3.2)];
const fixture=():LongformSentenceAlignmentInputV1=>({paragraphs:[{id:"p1",text:"Click save."},{id:"p2",text:"Open menu."}],
  words,issues:[],narrationSourceStart:7,narrationDuration:5,language:"en",
  recordings:[{recordingId:"screen",sourceSha256:"a".repeat(64),sourceStart:20,duration:10,
    words:words.map(row=>({...row,start:row.start+1,end:row.end+1})),wordArtifactId:"b".repeat(64)}]});
it("aligns sentences to actual word ranges, recording source clocks and script chapters",()=>{
  const input=fixture(),before=JSON.stringify(input),draft=alignLongformSentencesV1(input);
  expect(draft.sentences.map(row=>row.clock)).toEqual([{start:.4,end:1.2,authority:"recognizer_words"},{start:2.1,end:3.2,authority:"recognizer_words"}]);
  expect(draft.sentences.map(row=>row.recordingCandidates[0].sourceStart)).toEqual([21.4,23.1]);
  expect(draft.sentences.every(row=>row.preferredCandidateId)).toBe(true);
  expect(draft.chapters.map(row=>[row.title,row.start,row.end])).toEqual([["Click save.",.4,1.2],["Open menu.",2.1,3.2]]);
  expect(draft.narration).toEqual({sourceStart:7,duration:5,preservedDuration:5,removedDuration:0});
  expect(draft.contentVerified).toBe(false);expect(draft.projectModified).toBe(false);expect(JSON.stringify(input)).toBe(before);
});
it("retains partial script matches and never gives a missing word a manufactured time",()=>{
  const input=fixture();input.paragraphs=[{id:"p1",text:"Click the save button."},{id:"p2",text:"Open menu."}];
  const draft=alignLongformSentencesV1(input),first=draft.sentences[0];
  expect(first.alignment).toBe("PARTIAL_TEXT_MATCH");expect(first.flags).toContain("PARTIAL_SCRIPT_MATCH");
  expect(first.wordIndexes).toEqual([0,1]);expect(first.clock).toEqual({start:.4,end:1.2,authority:"recognizer_words"});
  expect(draft.sentences[1].clock).toEqual({start:2.1,end:3.2,authority:"recognizer_words"});
  expect(draft.narration.removedDuration).toBe(0);expect(draft.syntheticTimingUsed).toBe(false);
});
it("keeps an unrelated sentence unaligned while allowing a following real sentence to match",()=>{
  const input=fixture();input.paragraphs=[{id:"p1",text:"Zebras gallop quickly."},{id:"p2",text:"Click save."}];
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].clock).toBeUndefined();
  expect(draft.sentences[0].alignment).toBe("UNALIGNED");expect(draft.sentences[1].clock?.start).toBe(.4);
  expect(draft.chapters[0].start).toBeUndefined();expect(draft.chapters[0].flags).toContain("INCOMPLETE_SCRIPT_CLOCKS");
});
it("reports disputed recognizer ranges and repeated recording alternatives",()=>{
  const input=fixture();input.issues=[{code:"UNTIMED_WORD",windowIndex:0,segmentIndex:0,text:"missing"}];
  input.recordings=[input.recordings[0],{...input.recordings[0],recordingId:"screen-two"}];
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].flags).toContain("NARRATION_TIMING_REVIEW");
  expect(draft.sentences[0].recordingCandidates).toHaveLength(2);expect(draft.sentences[0].preferredCandidateId).toBeUndefined();
  expect(draft.sentences[0].flags).toContain("RECORDING_MATCH_AMBIGUOUS");
});
it("maps astral/CJK codepoints to word indexes without confusing UTF-16 source offsets",()=>{
  const text="𠀀中文測試。",input={...fixture(),language:"zh"as const,paragraphs:[{id:"p",text}],
    words:[word("𠀀中文",.3,.9),word("測試",1.1,1.7)],recordings:[]};
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].alignment).toBe("NORMALIZED_TEXT_MATCH");
  expect(draft.sentences[0].sourceCharacterEnd).toBe(text.length);expect(draft.sentences[0].wordIndexes).toEqual([0,1]);
  expect(draft.sentences[0].clock).toEqual({start:.3,end:1.7,authority:"recognizer_words"});
});
it("normalizes comparison text while retaining the creator's original sentence",()=>{
  const input={...fixture(),paragraphs:[{id:"p",text:"ＣＬＩＣＫ Save!"}]};
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].text).toBe("ＣＬＩＣＫ Save!");
  expect(draft.sentences[0].alignment).toBe("NORMALIZED_TEXT_MATCH");
});
it("does not call differing Latin word boundaries an exact transcript match",()=>{
  const input={...fixture(),paragraphs:[{id:"p",text:"Now here."}],words:[word("Nowhere",.4,1.2)],recordings:[]};
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].alignment).not.toBe("NORMALIZED_TEXT_MATCH");
  expect(draft.sentences[0].flags).toContain("PARTIAL_SCRIPT_MATCH");
});
it("uses bounded real cue ranges and evidence-linked semantic proposals without claiming visual truth",()=>{
  const input=fixture();input.recordings=[{recordingId:"screen",sourceSha256:"a".repeat(64),sourceStart:30,duration:8,materialId:"c".repeat(64),
    cues:[{start:2,end:4,text:"Click save.",index:0}],semantics:[{start:4,end:6,summary:"Open menu.",index:0,evidenceFrameIds:["frame-01"]}]}];
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].recordingCandidates[0]).toMatchObject({
    sourceStart:32,sourceEnd:34,authority:"recognizer_cues",cueIndexes:[0],contentVerified:false});
  expect(draft.sentences[1].recordingCandidates[0]).toMatchObject({sourceStart:34,sourceEnd:36,
    authority:"evidence_linked_semantics",evidenceFrameIds:["frame-01"],contentVerified:false});
  expect(draft.sentences[1].preferredCandidateId).toBeUndefined();
});
it("does not promote an unreferenced semantic description or punctuation-only text",()=>{
  const input=fixture();input.recordings=[{recordingId:"screen",sourceSha256:"a".repeat(64),sourceStart:0,duration:8,
    semantics:[{start:1,end:3,summary:"Click save.",index:0,evidenceFrameIds:[]}]}];
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].recordingCandidates).toEqual([]);
  const empty=alignLongformSentencesV1({...input,paragraphs:[{id:"p",text:"..."}]});
  expect(empty.sentences[0].recordingCandidates).toEqual([]);expect(empty.sentences[0].clock).toBeUndefined();
});
it("uses caller chapter labels only for existing paragraphs and keeps inferred labels distinct",()=>{
  const input=fixture();input.chapterTitles=[{paragraphId:"p1",title:"Saving"}];
  const draft=alignLongformSentencesV1(input);expect(draft.chapters[0]).toMatchObject({title:"Saving",titleAuthority:"caller"});
  expect(draft.chapters[1].titleAuthority).toBe("script_first_line");
  expect(()=>alignLongformSentencesV1({...input,chapterTitles:[{paragraphId:"missing",title:"wrong"}]})).toThrow("LONGFORM_ALIGNMENT_CHAPTER_ID");
});
it("keeps every sentence and narration when the comparison budget runs out",()=>{
  const draft=alignLongformSentencesV1({...fixture(),maximumComparisons:1});
  expect(draft.sentences).toHaveLength(2);expect(draft.sentences.every(row=>!row.clock)).toBe(true);
  expect(draft.sentences[0].flags).toContain("ALIGNMENT_BUDGET");expect(draft.narration.preservedDuration).toBe(5);
  expect(draft.stats.comparisonUnits).toBeLessThanOrEqual(1);
});
it("admits a long exact sentence without allocating a quadratic fallback matrix",()=>{
  const text="字".repeat(1500),input={...fixture(),language:"zh"as const,paragraphs:[{id:"p",text}],words:[word(text,.2,4)],recordings:[]};
  const draft=alignLongformSentencesV1(input);expect(draft.sentences[0].alignment).toBe("NORMALIZED_TEXT_MATCH");
  expect(draft.sentences[0].clock).toEqual({start:.2,end:4,authority:"recognizer_words"});
});
it("refuses invalid clocks, duplicate sources, out-of-source cue ranges and cancellation",()=>{
  expect(()=>alignLongformSentencesV1({...fixture(),words:[word("bad",4,6)]})).toThrow("LONGFORM_ALIGNMENT_WORD_CLOCK");
  const input=fixture();input.recordings=[input.recordings[0],input.recordings[0]];
  expect(()=>alignLongformSentencesV1(input)).toThrow("LONGFORM_ALIGNMENT_DUPLICATE_ID");
  expect(()=>alignLongformSentencesV1({...fixture(),recordings:[{recordingId:"r",sourceSha256:"a".repeat(64),sourceStart:0,duration:3,
    cues:[{start:1,end:4,text:"save",index:0}]}]})).toThrow("LONGFORM_ALIGNMENT_RECORDING_RANGE");
  const stop=new AbortController();stop.abort();expect(()=>alignLongformSentencesV1({...fixture(),signal:stop.signal})).toThrow();
});
it("validates the versioned request before reading artifacts or choosing evidence",()=>{
  const request={schema:"editkin.longform-sentence-alignment-request/v1",narrationArtifactId:"a".repeat(64)};
  expect(longformSentenceAlignmentRequestV1Schema.parse(request)).toMatchObject({recordingEvidence:[],chapterTitles:[]});
  expect(longformSentenceAlignmentRequestV1Schema.safeParse({...request,model:"medium"}).success).toBe(false);
  const ref={kind:"word_timing",recordingId:"r",artifactId:"b".repeat(64)};
  expect(longformSentenceAlignmentRequestV1Schema.safeParse({...request,recordingEvidence:[ref,ref]}).success).toBe(false);
});
