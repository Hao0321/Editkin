import type {McpServer} from "@modelcontextprotocol/server";
import {afterEach,it,expect,vi} from "vitest";
import {LongformUiFocusJobsV1} from "../application/longformUiFocusJobsV1";
import {closeLongformUiFocusHoldJobsV1} from "../application/longformUiFocusHoldJobsV1";
import {closeLongformUiFocusGeometryJobsV1} from "../application/longformUiFocusGeometryJobsV1";
import {uiFocusGeometryJobFixtureV1} from "../application/longformUiFocusGeometryJobsV1.fixture";
import {summarizeLongformUiFocusArtifactV1} from "../application/longformUiFocusArtifactV1";
import {confirmLongformUiFocusV1} from "../application/longformUiFocusV1";
import {describeLongformUiFocusGeometryV1} from "../application/longformUiFocusGeometryDraftV1";
import {registerLongformUiFocusToolsV1} from "./longformUiFocusToolsV1";
import {registerLongformUiFocusHoldToolsV1} from "./longformUiFocusHoldToolsV1";
import {registerLongformUiFocusGeometryToolsV1,LONGFORM_UI_FOCUS_GEOMETRY_TOOLS_V1} from "./longformUiFocusGeometryToolsV1";
type Response={content:Array<{type:string;text?:string}>;isError?:boolean};
type Entry={config:{inputSchema:{parse(raw:unknown):unknown};annotations:unknown};handler:(raw:never)=>Promise<Response>};
const sources:LongformUiFocusJobsV1[]=[];afterEach(async()=>{await Promise.all([closeLongformUiFocusGeometryJobsV1(),closeLongformUiFocusHoldJobsV1()]);await Promise.all(sources.splice(0).map(o=>o.close()));});
const turn=()=>new Promise<void>(done=>setImmediate(done)),value=(r:Response)=>JSON.parse(r.content[0].text!);
async function fixture(){const f=await uiFocusGeometryJobFixtureV1(),entries=new Map<string,Entry>(),server={registerTool:vi.fn((name,config,handler)=>entries.set(name,{config,handler}))} as unknown as McpServer;
  const source=new LongformUiFocusJobsV1({prepare:async()=>summarizeLongformUiFocusArtifactV1(f.artifact)});sources.push(source);
  const session=registerLongformUiFocusToolsV1(server,{EDITKIN_WORKSPACE:'D:/owned'},{jobs:source,read:async()=>f.artifact,
    image:async()=>({frame:f.frame,data:f.image}),confirm:async(a,ids)=>({...confirmLongformUiFocusV1(a.draft,{draftId:a.draft.draftId,candidateIds:ids}),
      artifactId:a.artifactId,projectRevision:a.project.revision,artworkStatus:'ART_PENDING_CLAUDE',selectableByDefault:false})});
  const holds=registerLongformUiFocusHoldToolsV1(server,session,{assertOwned:id=>source.assertArtifactOwned(id),assertViewed:(id,ids)=>source.assertFramesReturned(id,ids),
    confirmations:session.confirmations,read:async()=>f.artifact,prepare:async()=>f.result,validateCurrent:async()=>{}});
  const prepare=vi.fn(async(id:string,signal:AbortSignal)=>holds.withReadyResult(id,async()=>f.value,signal)),validateCurrent=vi.fn(async(id:string)=>holds.withReadyResult(id,async held=>{
    if(describeLongformUiFocusGeometryV1(f.value.project,f.value.handle).holdReceiptSha256!==held.receiptSha256)throw Error('hold changed');}));
  registerLongformUiFocusGeometryToolsV1(server,session,holds,{admitHold:id=>holds.assertReadyOwned(id),prepare,validateCurrent});
  const call=async(name:string,raw:unknown)=>{const entry=entries.get(name)!;return entry.handler(entry.config.inputSchema.parse(raw) as never);};
  await call('start_longform_ui_focus_detection',f.artifact.request);await turn();
  const ready=async()=>{await call('view_longform_ui_focus_frames',{artifactId:f.artifact.artifactId,frameIds:[f.candidate.frameId]});
    await call('confirm_longform_ui_focus_targets',{artifactId:f.artifact.artifactId,candidateIds:[f.candidate.candidateId]});
    const hold=value(await call('start_longform_ui_focus_hold',f.request));await turn();return hold.jobId as string;};
  return{...f,entries,prepare,validateCurrent,call,ready,holds};}
it('adds exactly four bounded read-only geometry tools and derives frames from this connection confirmed ready hold ID',async()=>{
  const f=await fixture();expect([...f.entries.keys()].slice(-4)).toEqual([...LONGFORM_UI_FOCUS_GEOMETRY_TOOLS_V1]);
  expect(f.entries.get('start_longform_ui_focus_geometry')!.config.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
  const holdJobId=await f.ready(),ticket=value(await f.call('start_longform_ui_focus_geometry',{holdJobId}));await turn();
  expect(value(await f.call('get_longform_ui_focus_geometry_job',{jobId:ticket.jobId}))).toMatchObject({state:'COMPLETED',result:{frameCount:24,focusHintsReady:false}});
  const page=value(await f.call('read_longform_ui_focus_geometry_frames',{jobId:ticket.jobId,offset:3,limit:2}));
  expect(page.items.map((r:{projectFrame:number})=>r.projectFrame)).toEqual([11,12]);expect(page.nextOffset).toBe(5);expect(page.nativePresentationVerified).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256*1024);expect(value(await f.call('cancel_longform_ui_focus_geometry_job',{jobId:ticket.jobId})).state).toBe('COMPLETED');
});
it('rejects foreign/nonready hold IDs and strict schemas reject manual coordinates, paths or receipts before preparation',async()=>{
  const f=await fixture();expect((await f.call('start_longform_ui_focus_geometry',{holdJobId:'uh-'+'f'.repeat(24)})).isError).toBe(true);expect(f.prepare).not.toHaveBeenCalled();
  const holdJobId=await f.ready();for(const extra of [{bounds:{}},{sourcePath:'D:/manual.mp4'},{clock:{}},{receiptSha256:'a'.repeat(64)}])
    await expect(f.call('start_longform_ui_focus_geometry',{holdJobId,...extra})).rejects.toThrow();
  await expect(f.call('read_longform_ui_focus_geometry_frames',{jobId:'ug-'+'a'.repeat(24),limit:33})).rejects.toThrow();expect(f.prepare).not.toHaveBeenCalled();
});
it('refuses a revoked ready hold/source when completed geometry is queried or paged',async()=>{
  const f=await fixture(),holdJobId=await f.ready(),ticket=value(await f.call('start_longform_ui_focus_geometry',{holdJobId}));await turn();
  f.validateCurrent.mockRejectedValue(Error('current project changed'));
  expect(value(await f.call('get_longform_ui_focus_geometry_job',{jobId:ticket.jobId})).error).toBe('current project changed');
  expect(value(await f.call('read_longform_ui_focus_geometry_frames',{jobId:ticket.jobId})).error).toBe('current project changed');
});
