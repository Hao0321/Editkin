import { describe, expect, it } from "vitest";
import { beginBeatMarkerJobV1, prepareBeatMarkersV1, beatMarkerCommandForProjectV1, BEAT_MARKER_BATCH_LIMIT_V1, type BeatMarkerOptionsV1 } from "./beatMarkersV1";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
import { createEmptyProject, migrateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { projectSchema, editorCommandSchema } from "../domain/schema";
import { buildTimelineSnapIndex } from "../ui/timelineSnapping";

function fixture(duration=12) {
  const project=createEmptyProject("Beat marker control",{id:"beat-control",width:96,height:64,fps:24});
  project.assets=[{id:"music",name:"Original click track",kind:"audio",uri:"owned://original.wav",duration}];
  const track=project.tracks.find(t=>t.kind==="audio")!;
  track.clips=[{id:"music-clip",assetId:"music",trackId:track.id,timelineStart:3.25,sourceStart:2.25,duration:6.25,volume:1,color:{...DEFAULT_COLOR},transform:{...DEFAULT_TRANSFORM},keyframes:[]}];
  const receipt=fixtureReceiptV1(duration);receipt.analysis.beats=Array.from({length:Math.floor(duration*2)},(_,i)=>({timeSeconds:i*.5,confidence:.8,downbeat:i%4===0,downbeatConfidence:i%4===0?.7:.1}));
  const input={request:{sourcePath:"D:/owned/original.wav",sourceStartSeconds:0,durationSeconds:duration},source:{assetId:"music",assetUri:project.assets[0].uri,sourceSha256:receipt.sourceSha256,sourceBytes:receipt.sourceBytes,ffmpegSha256:receipt.ffmpegSha256},receipt};
  const options:BeatMarkerOptionsV1={idPrefix:"beat-control",createdAt:"2026-10-17T00:00:00.000Z",labels:{beat:"Beat",downbeat:"Downbeat candidate",candidateNote:"Analysis candidate; four-beat meter hypothesis needs listening review."}};
  return {project,track,clip:track.clips[0],input,options};
}
function prepared(f=fixture(),extra:Partial<BeatMarkerOptionsV1>={}) {
  const job=beginBeatMarkerJobV1(f.project,f.clip.id),plan=prepareBeatMarkersV1(f.project,job,f.input,{...f.options,...extra});return{...f,job,plan};
}
const marker=(id:string,time:number,kind:"beat"|"note"="beat")=>({id,time,title:"Keep user annotation",note:"User content",kind,status:"resolved" as const,createdAt:"2026-10-16T00:00:00.000Z"});
describe("native beat receipt to existing editor markers",()=>{
  it("defaults to observed downbeats, maps a source trim and preserves native events",()=>{
    const f=fixture(),before=JSON.stringify(f.input),p=prepared(f).plan;
    expect(p.mode).toBe("downbeats");expect(p.events.map(e=>e.time)).toEqual([5,7,9]);expect(p.events.map(e=>e.sourceSeconds)).toEqual([4,6,8]);expect(p.markerCount).toBe(3);expect(p.realMusicQualityCertified).toBe(false);expect(p.vaDefaultEligible).toBe(false);expect(JSON.stringify(f.input)).toBe(before);
  });
  it("adds all beats only on explicit request and never includes the clip end",()=>{
    const p=prepared(fixture(),{mode:"all"}).plan;expect(p.markerCount).toBe(12);expect(p.events[0].time).toBe(3.5);expect(p.events.at(-1)!.time).toBe(9);expect(p.events.every(e=>e.time>=3.25&&e.time<9.5)).toBe(true);
  });
  it("uses one actual history batch, one Undo/Redo and existing snapping",()=>{
    const f=prepared(),before=JSON.stringify(f.project),command=beatMarkerCommandForProjectV1(f.project,f.plan)!;editorCommandSchema.parse(command);
    const h=dispatchCommand(createHistory(f.project),command,"beat-add");expect(h.past).toHaveLength(1);expect(h.journal).toHaveLength(1);expect(h.present.director.markers).toHaveLength(3);expect(JSON.stringify(f.project)).toBe(before);
    expect(buildTimelineSnapIndex(h.present).filter(p=>p.owner.startsWith("marker:")).map(p=>p.time)).toEqual([5,7,9]);
    const undone=undo(h);expect(undone.present.director.markers).toEqual(f.project.director.markers);expect(undone.present.tracks).toEqual(f.project.tracks);expect(redo(undone).present.director.markers).toEqual(h.present.director.markers);
    const reopened=projectSchema.parse(migrateProject(JSON.parse(JSON.stringify(h.present))));expect(reopened.director.markers).toEqual(h.present.director.markers);
  });
  it("keeps user beat markers and other notes, and does not generate another Undo on repeat",()=>{
    const f=fixture();f.project.director.markers=[marker("user-beat",5),marker("user-note",7,"note")];const a=prepared(f);expect(a.plan.markerCount).toBe(2);
    const h=dispatchCommand(createHistory(f.project),beatMarkerCommandForProjectV1(f.project,a.plan)!);expect(h.present.director.markers.slice(0,2)).toEqual(f.project.director.markers);
    const job=beginBeatMarkerJobV1(h.present,f.clip.id),again=prepareBeatMarkersV1(h.present,job,f.input,f.options);expect(again.emptyReason).toBe("no-new-markers");expect(beatMarkerCommandForProjectV1(h.present,again)).toBeUndefined();expect(h.past).toHaveLength(1);
  });
  it("never replaces colliding user IDs",()=>{const f=fixture();f.project.director.markers=[marker("beat-control-120",1,"note")];const before=JSON.stringify(f.project);expect(()=>prepared(f)).toThrow("ID_COLLISION");expect(JSON.stringify(f.project)).toBe(before);});
  it("merges same-frame events with downbeat priority and then confidence",()=>{
    const f=fixture();f.input.receipt.analysis.beats=[{timeSeconds:3,confidence:.99,downbeat:false,downbeatConfidence:0},{timeSeconds:3.005,confidence:.2,downbeat:true,downbeatConfidence:.7},{timeSeconds:3.01,confidence:.8,downbeat:true,downbeatConfidence:.7}];
    const p=prepared(f,{mode:"all"}).plan;expect(p.markerCount).toBe(1);expect(p.events[0].analysisIndex).toBe(2);expect(p.events[0].downbeat).toBe(true);expect(p.stats.duplicateFrames).toBe(2);
  });
  it.each([24000/1001,30000/1001,60000/1001])("keeps a late10hour timeline frame grid at %f fps",fps=>{
    const f=fixture();f.project.fps=fps;f.clip.timelineStart=36000+10/fps;const p=prepared(f,{mode:"all"}).plan;expect(p.markerCount).toBe(12);
    for(const e of p.events){expect(e.frame).toBe(Math.round(e.time*fps));expect(Math.abs(e.quantizationErrorFrames)).toBeLessThanOrEqual(.5);expect(e.time).toBeGreaterThanOrEqual(f.clip.timelineStart);expect(e.time).toBeLessThan(f.clip.timelineStart+f.clip.duration);}
  });
  it("honours an explicit half-open range and drops events rounded outside it",()=>{
    const f=fixture();f.input.receipt.analysis.beats=[{timeSeconds:2.26,confidence:.8,downbeat:true,downbeatConfidence:.7},{timeSeconds:4,confidence:.8,downbeat:true,downbeatConfidence:.7},{timeSeconds:8.49,confidence:.8,downbeat:true,downbeatConfidence:.7}];
    const p=prepared(f,{timelineRange:{start:3.251,end:9.5}}).plan;expect(p.events.map(e=>e.time)).toEqual([5]);expect(p.stats.boundaryEvents).toBe(2);
  });
  it.each(["no-beats","no-downbeats"])("returns an explicit empty %s result without a fabricated bar grid",kind=>{
    const f=fixture();f.input.receipt.analysis.beats=kind==="no-beats"?[]:f.input.receipt.analysis.beats.map(b=>({...b,downbeat:false,downbeatConfidence:0}));const {plan}=prepared(f);expect(plan.state).toBe("empty");expect(plan.command).toBeUndefined();expect(plan.emptyReason).toBe(kind==="no-beats"?"no-beats":"no-downbeats-in-range");
  });
  it.each(["revision","fps","clip","asset","markers","project-id"])("refuses a stale %s before preparing",change=>{
    const f=fixture(),job=beginBeatMarkerJobV1(f.project,f.clip.id);if(change==="revision")f.project.revision++;if(change==="fps")f.project.fps=30;if(change==="clip")f.clip.sourceStart+=.1;if(change==="asset")f.project.assets[0].uri="changed.wav";if(change==="markers")f.project.director.markers.push(marker("new-user-note",0,"note"));if(change==="project-id")f.project.id="other";
    expect(()=>prepareBeatMarkersV1(f.project,job,f.input,f.options)).toThrow("STALE");
  });
  it("checks the current project again immediately before dispatch",()=>{const f=prepared();f.project.director.markers.push(marker("late-note",0,"note"));expect(()=>beatMarkerCommandForProjectV1(f.project,f.plan)).toThrow("STALE");});
  it("rejects serialized/forged live jobs and plans",()=>{const f=prepared();expect(()=>prepareBeatMarkersV1(f.project,JSON.parse(JSON.stringify(f.job)),f.input,f.options)).toThrow("FOREIGN");expect(()=>beatMarkerCommandForProjectV1(f.project,JSON.parse(JSON.stringify(f.plan)))).toThrow("FOREIGN");});
  it("returns independent commands while freezing the reviewable plan",()=>{const f=prepared(),a=beatMarkerCommandForProjectV1(f.project,f.plan)!;if(a.type==="batch"&&a.commands[0].type==="add_director_marker")a.commands[0].marker.time=0;expect(beatMarkerCommandForProjectV1(f.project,f.plan)).not.toEqual(a);expect(Object.isFrozen(f.plan)).toBe(true);expect(Object.isFrozen(f.plan.command)).toBe(true);expect(Object.isFrozen(f.plan.events[0])).toBe(true);});
  it.each(["before","after"])("honours cancellation %s preparation",stage=>{const f=fixture(),a=new AbortController(),job=beginBeatMarkerJobV1(f.project,f.clip.id);if(stage==="before")a.abort(Error("owner cancelled"));if(stage==="before")expect(()=>prepareBeatMarkersV1(f.project,job,f.input,{...f.options,signal:a.signal})).toThrow("owner cancelled");else{const p=prepareBeatMarkersV1(f.project,job,f.input,{...f.options,signal:a.signal});a.abort(Error("owner cancelled"));expect(()=>beatMarkerCommandForProjectV1(f.project,p)).toThrow("owner cancelled");}});
  it.each(["locked","speed","curve","composition","image","controller"])("refuses %s selections",kind=>{const f=fixture();if(kind==="locked")f.track.locked=true;if(kind==="speed")f.clip.speed=2;if(kind==="curve")f.clip.timeRemap={} as never;if(kind==="composition")f.project.assets[0].compositionId="nested";if(kind==="image")f.project.assets[0].kind="image";if(kind==="controller")f.clip.layer={enabled:true,role:"controller",blendMode:"normal"};expect(()=>beginBeatMarkerJobV1(f.project,f.clip.id)).toThrow();});
  it("analyses a B4 derivative in its own current source clock",()=>{const f=fixture();f.project.assets[0].clipRetime={} as never;expect(prepared(f).plan.markerCount).toBe(3);});
  it.each(["asset-id","uri","sha","bytes","ffmpeg","decoder-open","sample-count","unsorted","window","unknown-request"])("refuses %s receipt/binding without any project mutation",kind=>{
    const f=fixture(),before=JSON.stringify(f.project);if(kind==="asset-id")f.input.source.assetId="other";if(kind==="uri")f.input.source.assetUri="foreign.wav";if(kind==="sha")f.input.source.sourceSha256="d".repeat(64);if(kind==="bytes")f.input.source.sourceBytes++;if(kind==="ffmpeg")f.input.source.ffmpegSha256="d".repeat(64);if(kind==="decoder-open")f.input.receipt.decoderAudit[0].treeClosed=false;if(kind==="sample-count")f.input.receipt.analysis.decodedSamples--;if(kind==="unsorted")f.input.receipt.analysis.beats.reverse();if(kind==="window"){f.input.request.durationSeconds=4;f.input.receipt=fixtureReceiptV1(4);}if(kind==="unknown-request")Object.assign(f.input.request,{model:"not-authorized"});expect(()=>prepared(f)).toThrow();expect(JSON.stringify(f.project)).toBe(before);
  });
  it.each(["prefix","date","labels","mode","range","fps"])("refuses malformed %s",kind=>{const f=fixture();if(kind==="prefix")f.options.idPrefix="bad prefix";if(kind==="date")f.options.createdAt="yesterday";if(kind==="labels")f.options.labels.beat="";if(kind==="mode")f.options.mode="invented" as never;if(kind==="range")f.options.timelineRange={start:0,end:1};if(kind==="fps")f.project.fps=Infinity;expect(()=>prepared(f)).toThrow();});
  it("accepts the exact bounded limit, refuses excess without truncation, and accepts a smaller range",()=>{
    const total=BEAT_MARKER_BATCH_LIMIT_V1+1,f=fixture(total*.2+1);f.clip.timelineStart=0;f.clip.sourceStart=0;f.clip.duration=f.project.assets[0].duration;f.project.fps=30;
    f.input.receipt.analysis.beats=Array.from({length:total},(_,i)=>({timeSeconds:i*.2,confidence:.8,downbeat:true,downbeatConfidence:.7}));
    expect(()=>prepared(f)).toThrow("BATCH_LIMIT");const {plan}=prepared(f,{timelineRange:{start:0,end:BEAT_MARKER_BATCH_LIMIT_V1*.2}});expect(plan.markerCount).toBe(BEAT_MARKER_BATCH_LIMIT_V1);expect(prepared(f,{timelineRange:{start:0,end:1}}).plan.markerCount).toBe(5);
  });
  it("uses a validated decimal request boundary and still refuses a genuinely incomplete window",()=>{
    const duration=4097*.2+1,f=fixture(duration);f.clip.timelineStart=0;f.clip.sourceStart=0;f.clip.duration=duration;f.input.receipt.analysis.beats=[{timeSeconds:1,confidence:.8,downbeat:true,downbeatConfidence:.7}];
    expect(duration).toBeGreaterThan(f.input.receipt.analysis.durationSeconds);expect(prepared(f).plan.markerCount).toBe(1);
    f.clip.duration=duration+1/16000;expect(()=>prepared(f)).toThrow("WINDOW_INCOMPLETE");
  });
});
