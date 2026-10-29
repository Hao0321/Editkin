import type { LongformAlignedSentenceV1, LongformRecordingCandidateV1, LongformRecordingTextEvidenceV1,
  LongformSentenceAlignmentDraftV1 } from "../domain/longformSentenceAlignmentV1";
import type { LongformTimedWordV1, LongformWordTimingIssueV1 } from "../domain/longformWordTimingV1";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";

const normal=(text:string)=>text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,"")
  .replace(/(?<=[\p{Script=Latin}\p{N}])\s+(?=[\p{Script=Latin}\p{N}])/gu,"\u0001")
  .replace(/\s+/gu,"").replaceAll("\u0001"," ");
const latinEdge=/[\p{Script=Latin}\p{N}]/u;
const round=(value:number)=>Math.round(value*1e6)/1e6;
interface TextClock { text:string;characters:string[];wordAt:number[];words:readonly LongformTimedWordV1[] }
interface Budget { remaining:number;used:number }
const spend=(budget:Budget,count:number)=>{if(count>budget.remaining)return false;budget.remaining-=count;budget.used+=count;return true;};
function textClock(words:readonly LongformTimedWordV1[],duration:number):TextClock {
  if(words.length>200000)throw new Error("LONGFORM_ALIGNMENT_WORD_BUDGET");
  const characters:string[]=[],wordAt:number[]=[];
  words.forEach((word,index)=>{
    if(!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<=word.start||word.end>duration)
      throw new Error("LONGFORM_ALIGNMENT_WORD_CLOCK");
    const normalized=normal(word.text);
    if(normalized&&characters.length&&latinEdge.test(characters.at(-1)!)&&latinEdge.test([...normalized][0])){
      characters.push(" ");wordAt.push(index);
    }
    for(const character of normalized){characters.push(character);wordAt.push(index);}
  });
  if(characters.length>2_000_000)throw new Error("LONGFORM_ALIGNMENT_CHARACTER_BUDGET");
  return{text:characters.join(""),characters,wordAt,words};
}
interface Match { positions:number[];coverage:number;exact:boolean;end:number;budgetExceeded?:boolean;repeated?:boolean }
function matchText(expected:string,source:TextClock,cursor:number,budget:Budget,endBound=source.characters.length):Match {
  const needle=normal(expected),wanted=[...needle],available=endBound-cursor;
  if(!wanted.length||available<=0)return{positions:[],coverage:0,exact:false,end:cursor};
  if(!spend(budget,available))return{positions:[],coverage:0,exact:false,end:cursor,budgetExceeded:true};
  // UTF-16 offsets from indexOf cannot be used as codepoint/word indexes.
  const tail=source.characters.slice(cursor,endBound).join(""),exactOffset=tail.indexOf(needle);
  if(exactOffset>=0){
    const at=cursor+[...tail.slice(0,exactOffset)].length;
    return{positions:Array.from({length:wanted.length},(_,i)=>at+i),coverage:1,exact:true,end:at+wanted.length,
      repeated:tail.indexOf(needle,exactOffset+needle.length)>=0};
  }
  if(wanted.length>1024)return{positions:[],coverage:0,exact:false,end:cursor,budgetExceeded:true};
  const observed=source.characters.slice(cursor,Math.min(endBound,cursor+Math.min(2048,Math.max(256,wanted.length*3+128))));
  const columns=observed.length+1,cells=(wanted.length+1)*columns;
  if(!spend(budget,cells))return{positions:[],coverage:0,exact:false,end:cursor,budgetExceeded:true};
  const trace=new Uint8Array(cells);let prior=new Uint16Array(columns),row=new Uint16Array(columns);
  for(let i=1;i<=wanted.length;i++){
    row[0]=i;trace[i*columns]=1;
    for(let j=1;j<columns;j++){
      const diagonal=prior[j-1]+(wanted[i-1]===observed[j-1]?0:1),deleted=prior[j]+1,inserted=row[j-1]+1;
      const cost=Math.min(diagonal,deleted,inserted);row[j]=cost;
      trace[i*columns+j]=cost===diagonal?3:cost===deleted?1:2;
    }[prior,row]=[row,prior];
  }
  let end=0;for(let j=1;j<columns;j++)if(prior[j]<prior[end])end=j;
  let i=wanted.length,j=end;const positions:number[]=[];
  while(i>0){const direction=trace[i*columns+j];
    if(direction===3){if(wanted[i-1]===observed[j-1])positions.push(cursor+j-1);i--;j--;}
    else if(direction===1||j===0)i--;else j--;
  }
  positions.reverse();
  const matchedPerWord=new Map<number,number>();for(const position of positions)if(source.characters[position]!==" "){
    const index=source.wordAt[position];matchedPerWord.set(index,(matchedPerWord.get(index)??0)+1);
  }
  const admitted=new Set([...matchedPerWord].filter(([index,count])=>{
    const text=normal(source.words[index].text);return !latinEdge.test(text)||count/[...text.replaceAll(" ","")].length>=.8;
  }).map(([index])=>index));
  const retained=positions.filter(position=>admitted.has(source.wordAt[position])),coverage=retained.length/wanted.length;
  if(coverage<.35||retained.length<Math.min(4,wanted.length))return{positions:[],coverage:0,exact:false,end:cursor};
  return{positions:retained,coverage:round(coverage),exact:false,end:retained.at(-1)!+1};
}
function wordSpan(source:TextClock,match:Match){
  const indexes=[...new Set(match.positions.map(position=>source.wordAt[position]))];
  if(!indexes.length)return;
  return{indexes,start:Math.min(...indexes.map(index=>source.words[index].start)),end:Math.max(...indexes.map(index=>source.words[index].end))};
}
function dice(expected:string,observed:string){
  const a=[...normal(expected)],b=[...normal(observed)];if(!a.length||!b.length)return 0;
  if(a.join("")===b.join(""))return 1;
  if(a.length<4||b.length<4)return 0;
  const grams=(chars:string[])=>{const rows=new Map<string,number>();for(let i=1;i<chars.length;i++){
    const key=chars[i-1]+chars[i];rows.set(key,(rows.get(key)??0)+1);}return rows;};
  const left=grams(a),right=grams(b);let shared=0;for(const[key,count]of left)shared+=Math.min(count,right.get(key)??0);
  return round(2*shared/(a.length+b.length-2));
}
function candidates(text:string,recordings:readonly LongformRecordingTextEvidenceV1[],clocks:Map<string,TextClock>,budget:Budget){
  const rows:LongformRecordingCandidateV1[]=[];
  if(!normal(text))return rows;
  for(const recording of recordings){
    const clock=clocks.get(recording.recordingId);
    if(clock){let cursor=0;for(let occurrence=0;occurrence<3;occurrence++){
      const match=matchText(text,clock,cursor,budget),span=wordSpan(clock,match);if(!span)break;
      rows.push({candidateId:`${recording.recordingId}:words:${span.indexes[0]}:${span.indexes.at(-1)}`,recordingId:recording.recordingId,
        sourceSha256:recording.sourceSha256,sourceStart:recording.sourceStart+span.start,sourceEnd:recording.sourceStart+span.end,
        score:match.coverage,authority:"recognizer_words",textMatch:match.exact?"normalized_exact":"partial",wordIndexes:span.indexes,contentVerified:false});
      if(!match.exact||!match.repeated)break;cursor=match.end;
    }}
    const cues=recording.cues??[];
    for(let i=0;i<cues.length;i++){
      let observed="";for(let j=i;j<Math.min(cues.length,i+4);j++){
        if(j>i&&cues[j].start-cues[j-1].end>10)break;observed+=" "+cues[j].text;
        if(!spend(budget,observed.length+text.length))break;
        const score=normal(observed).includes(normal(text))?1:dice(text,observed);if(score<.65)continue;
        rows.push({candidateId:`${recording.recordingId}:cues:${i}:${j}`,recordingId:recording.recordingId,
          sourceSha256:recording.sourceSha256,sourceStart:recording.sourceStart+cues[i].start,sourceEnd:recording.sourceStart+cues[j].end,
          score,authority:"recognizer_cues",textMatch:normal(observed).includes(normal(text))?"normalized_exact":"partial",
          cueIndexes:cues.slice(i,j+1).map(row=>row.index),contentVerified:false});
      }
    }
    for(const segment of recording.semantics??[]){
      if(!segment.evidenceFrameIds.length||!spend(budget,text.length+segment.summary.length))continue;
      const score=dice(text,segment.summary);if(score<.65)continue;
      rows.push({candidateId:`${recording.recordingId}:semantic:${segment.index}`,recordingId:recording.recordingId,
        sourceSha256:recording.sourceSha256,sourceStart:recording.sourceStart+segment.start,sourceEnd:recording.sourceStart+segment.end,
        score,authority:"evidence_linked_semantics",textMatch:"semantic_similarity",semanticSegmentIndex:segment.index,evidenceFrameIds:[...segment.evidenceFrameIds],contentVerified:false});
    }
  }
  rows.sort((a,b)=>b.score-a.score||a.sourceEnd-a.sourceStart-(b.sourceEnd-b.sourceStart)||compareUtf8Bytes(a.candidateId,b.candidateId));
  return rows.slice(0,3);
}
export interface LongformSentenceAlignmentInputV1 {
  paragraphs:readonly{id:string;text:string}[];words:readonly LongformTimedWordV1[];issues:readonly LongformWordTimingIssueV1[];
  narrationSourceStart:number;narrationDuration:number;language:"auto"|"zh"|"en"|"es"|"ja"|"ko";
  recordings:readonly LongformRecordingTextEvidenceV1[];chapterTitles?:readonly{paragraphId:string;title:string}[];
  signal?:AbortSignal;maximumComparisons?:number;
}
/** Suggestions bind their clocks to real matched words/cues. No interpolation,
 * speech deletion, visual truth, project commit or chapter artwork is implied. */
export function alignLongformSentencesV1(input:LongformSentenceAlignmentInputV1):LongformSentenceAlignmentDraftV1 {
  input.signal?.throwIfAborted();
  if(!Number.isFinite(input.narrationSourceStart)||input.narrationSourceStart<0||!Number.isFinite(input.narrationDuration)
    ||input.narrationDuration<=0||input.paragraphs.length>1024||input.recordings.length>256)throw new Error("LONGFORM_ALIGNMENT_INPUT");
  const maximum=input.maximumComparisons??40_000_000;
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100_000_000)throw new Error("LONGFORM_ALIGNMENT_COMPARISON_BUDGET");
  if(input.paragraphs.reduce((sum,row)=>sum+row.text.length,0)>500000)throw new Error("LONGFORM_ALIGNMENT_SCRIPT_BUDGET");
  const source=textClock(input.words,input.narrationDuration),budget:Budget={remaining:maximum,used:0},clocks=new Map<string,TextClock>();
  if(new Set(input.paragraphs.map(row=>row.id)).size!==input.paragraphs.length||new Set(input.recordings.map(row=>row.recordingId)).size!==input.recordings.length)
    throw new Error("LONGFORM_ALIGNMENT_DUPLICATE_ID");
  if(input.chapterTitles?.some(row=>!input.paragraphs.some(paragraph=>paragraph.id===row.paragraphId))
    ||new Set(input.chapterTitles?.map(row=>row.paragraphId)).size!==(input.chapterTitles?.length??0))throw new Error("LONGFORM_ALIGNMENT_CHAPTER_ID");
  let totalWords=input.words.length,totalCharacters=source.characters.length;
  for(const recording of input.recordings){
    if(!Number.isFinite(recording.sourceStart)||recording.sourceStart<0||!Number.isFinite(recording.duration)||recording.duration<=0)
      throw new Error("LONGFORM_ALIGNMENT_RECORDING_RANGE");
    for(const row of [...recording.cues??[],...recording.semantics??[]])if(!Number.isFinite(row.start)||!Number.isFinite(row.end)
      ||row.start<0||row.end<=row.start||row.end>recording.duration)throw new Error("LONGFORM_ALIGNMENT_RECORDING_RANGE");
    if(recording.words){
      totalWords+=recording.words.length;if(totalWords>200000)throw new Error("LONGFORM_ALIGNMENT_WORD_BUDGET");
      const clock=textClock(recording.words,recording.duration);totalCharacters+=clock.characters.length;
      if(totalCharacters>2_000_000)throw new Error("LONGFORM_ALIGNMENT_CHARACTER_BUDGET");clocks.set(recording.recordingId,clock);
    }
  }
  const segmenter=new Intl.Segmenter(input.language==="auto"?undefined:input.language,{granularity:"sentence"});
  const sentences:LongformAlignedSentenceV1[]=[],chapters:LongformSentenceAlignmentDraftV1["chapters"]=[];let cursor=0;
  for(const [paragraphPosition,paragraph]of input.paragraphs.entries()){
    input.signal?.throwIfAborted();const paragraphSentences:LongformAlignedSentenceV1[]=[];
    const parts=[...segmenter.segment(paragraph.text)];
    for(const[ordinal,part]of parts.entries()){
      if(!part.segment.trim())continue;if(sentences.length>=4096)throw new Error("LONGFORM_ALIGNMENT_SENTENCE_BUDGET");
      const following=parts.slice(ordinal+1).find(row=>row.segment.trim())?.segment
        ??(input.paragraphs[paragraphPosition+1]?[...segmenter.segment(input.paragraphs[paragraphPosition+1].text)].find(row=>row.segment.trim())?.segment:undefined);
      let endBound=source.characters.length;
      if(following&&normal(following)&&!normal(part.segment).includes(normal(following))&&spend(budget,endBound-cursor)){
        const tail=source.characters.slice(cursor).join(""),offset=tail.indexOf(normal(following));
        if(offset>=0)endBound=cursor+[...tail.slice(0,offset)].length;
      }
      const match=matchText(part.segment,source,cursor,budget,endBound),span=wordSpan(source,match);
      const sentence:LongformAlignedSentenceV1={id:`sentence-${sentences.length+1}`,paragraphId:paragraph.id,sentenceIndex:ordinal,text:part.segment,
        sourceCharacterStart:part.index,sourceCharacterEnd:part.index+part.segment.length,
        alignment:span?(match.exact?"NORMALIZED_TEXT_MATCH":"PARTIAL_TEXT_MATCH"):"UNALIGNED",coverage:match.coverage,
        wordIndexes:span?.indexes??[],flags:[],recordingCandidates:[]};
      if(span){sentence.clock={start:span.start,end:span.end,authority:"recognizer_words"};cursor=match.end;
        const disputed=span.indexes.some(index=>input.issues.some(issue=>issue.windowIndex===input.words[index].windowIndex
          &&issue.segmentIndex===input.words[index].segmentIndex));if(disputed)sentence.flags.push("NARRATION_TIMING_REVIEW");
      }else sentence.flags.push(match.budgetExceeded?"ALIGNMENT_BUDGET":"NO_MATCHED_WORD_CLOCK");
      if(match.repeated)sentence.flags.push("REPEATED_NARRATION_TEXT");if(span&&!match.exact)sentence.flags.push("PARTIAL_SCRIPT_MATCH");
      sentences.push(sentence);paragraphSentences.push(sentence);
    }
    const title=input.chapterTitles?.find(row=>row.paragraphId===paragraph.id),first=paragraphSentences[0],last=paragraphSentences.at(-1);
    const flags=paragraphSentences.some(row=>!row.clock)?["INCOMPLETE_SCRIPT_CLOCKS"]:[];
    if(paragraphSentences.some(row=>row.flags.length))flags.push("SENTENCES_REQUIRE_REVIEW");
    chapters.push({id:`chapter-${chapters.length+1}`,paragraphId:paragraph.id,
      title:title?.title??[...paragraph.text.split(/\r?\n/u)[0].trim().replace(/^#{1,6}\s+/u,"")].slice(0,160).join(""),
      titleAuthority:title?"caller":"script_first_line",sentenceIds:paragraphSentences.map(row=>row.id),
      ...(first?.clock?{start:first.clock.start}:{}),...(last?.clock?{end:last.clock.end}:{}),flags});
  }
  // Establish every possible narration clock before spending the remaining
  // comparison budget ranking alternative recording evidence.
  for(const sentence of sentences){
    input.signal?.throwIfAborted();sentence.recordingCandidates=candidates(sentence.text,input.recordings,clocks,budget);
    const[first,second]=sentence.recordingCandidates;
    if(first&&sentence.clock&&first.textMatch==="normalized_exact"&&(!second||first.score-second.score>=.15))sentence.preferredCandidateId=first.candidateId;
    if(!first)sentence.flags.push("NO_RECORDING_EVIDENCE");else if(!sentence.preferredCandidateId)sentence.flags.push("RECORDING_MATCH_AMBIGUOUS");
    if(first&&first.authority!=="recognizer_words")sentence.flags.push("RECORDING_CUE_OR_SEMANTIC_RANGE");
  }
  for(const chapter of chapters)if(sentences.some(sentence=>sentence.paragraphId===chapter.paragraphId&&sentence.flags.length)
    &&!chapter.flags.includes("SENTENCES_REQUIRE_REVIEW"))chapter.flags.push("SENTENCES_REQUIRE_REVIEW");
  return{schema:"editkin.longform-sentence-alignment-draft/v1",clock:"narration_local_seconds",state:"REVIEW_REQUIRED",sentences,chapters,
    narration:{sourceStart:input.narrationSourceStart,duration:input.narrationDuration,preservedDuration:input.narrationDuration,removedDuration:0},
    stats:{sentenceCount:sentences.length,alignedSentenceCount:sentences.filter(row=>row.clock).length,
      matchedRecordingSentenceCount:sentences.filter(row=>row.recordingCandidates.length).length,chapterCount:chapters.length,comparisonUnits:budget.used},
    contentVerified:false,syntheticTimingUsed:false,projectModified:false};
}
