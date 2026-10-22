import * as z from "zod/v4";
import type { LongformTimedWordV1 } from "./longformWordTimingV1";

const sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(160);
export const longformSentenceAlignmentRequestV1Schema=z.strictObject({
  schema:z.literal("editkin.longform-sentence-alignment-request/v1"),narrationArtifactId:sha,
  recordingEvidence:z.array(z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("word_timing"),recordingId:id,artifactId:sha}),
    z.strictObject({kind:z.literal("material"),recordingId:id,materialId:sha,semanticReceiptSha256:sha.optional()}),
  ])).max(256).default([]),
  chapterTitles:z.array(z.strictObject({paragraphId:id,title:z.string().trim().min(1).max(200)})).max(1024).default([]),
}).superRefine((value,ctx)=>{
  if(new Set(value.recordingEvidence.map(row=>row.recordingId)).size!==value.recordingEvidence.length)
    ctx.addIssue({code:"custom",message:"Duplicate recording evidence"});
  if(new Set(value.chapterTitles.map(row=>row.paragraphId)).size!==value.chapterTitles.length)
    ctx.addIssue({code:"custom",message:"Duplicate chapter title"});
});
export type LongformSentenceAlignmentRequestV1=z.infer<typeof longformSentenceAlignmentRequestV1Schema>;
export interface LongformRecordingTextEvidenceV1 {
  recordingId:string;sourceSha256:string;sourceStart:number;duration:number;
  wordArtifactId?:string;words?:LongformTimedWordV1[];
  materialId?:string;packetSha256?:string;
  cues?:Array<{start:number;end:number;text:string;index:number}>;
  semanticReceiptSha256?:string;
  semantics?:Array<{start:number;end:number;summary:string;index:number;evidenceFrameIds:string[]}>;
}
export interface LongformRecordingCandidateV1 {
  candidateId:string;recordingId:string;sourceSha256:string;sourceStart:number;sourceEnd:number;
  score:number;authority:"recognizer_words"|"recognizer_cues"|"evidence_linked_semantics";
  textMatch:"normalized_exact"|"partial"|"semantic_similarity";
  wordIndexes?:number[];cueIndexes?:number[];semanticSegmentIndex?:number;evidenceFrameIds?:string[];
  contentVerified:false;
}
export interface LongformAlignedSentenceV1 {
  id:string;paragraphId:string;sentenceIndex:number;text:string;sourceCharacterStart:number;sourceCharacterEnd:number;
  alignment:"NORMALIZED_TEXT_MATCH"|"PARTIAL_TEXT_MATCH"|"UNALIGNED";
  coverage:number;wordIndexes:number[];clock?:{start:number;end:number;authority:"recognizer_words"};
  flags:string[];recordingCandidates:LongformRecordingCandidateV1[];preferredCandidateId?:string;
}
export interface LongformAlignedChapterV1 {
  id:string;paragraphId:string;title:string;titleAuthority:"caller"|"script_first_line";
  sentenceIds:string[];start?:number;end?:number;flags:string[];
}
export interface LongformSentenceAlignmentDraftV1 {
  schema:"editkin.longform-sentence-alignment-draft/v1";clock:"narration_local_seconds";
  state:"REVIEW_REQUIRED";sentences:LongformAlignedSentenceV1[];chapters:LongformAlignedChapterV1[];
  narration:{sourceStart:number;duration:number;preservedDuration:number;removedDuration:0};
  stats:{sentenceCount:number;alignedSentenceCount:number;matchedRecordingSentenceCount:number;chapterCount:number;comparisonUnits:number};
  contentVerified:false;syntheticTimingUsed:false;projectModified:false;
}
