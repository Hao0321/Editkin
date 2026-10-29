import {afterEach,it,expect,vi} from "vitest";
import {LongformUiFocusGeometryJobsV1,type LongformUiFocusGeometryOwnedV1} from "./longformUiFocusGeometryJobsV1";
import {uiFocusGeometryJobFixtureV1} from "./longformUiFocusGeometryJobsV1.fixture";
const owners:LongformUiFocusGeometryJobsV1[]=[];afterEach(async()=>{await Promise.all(owners.splice(0).map(o=>o.close()));});
const turn=()=>new Promise<void>(done=>setImmediate(done));
async function fixture(){const f=await uiFocusGeometryJobFixtureV1(),holdJobId='uh-'+'a'.repeat(24),prepare=vi.fn(async()=>f.value),validateCurrent=vi.fn(async()=>{});
  const owner=new LongformUiFocusGeometryJobsV1({admitHold:id=>{if(id!==holdJobId)throw Error('foreign or non-ready hold');},prepare,validateCurrent});owners.push(owner);
  return{...f,holdJobId,prepare,validateCurrent,owner};}
it('admits only an owned ready hold ID, strict request schema and a private prepared geometry handle',async()=>{
  const f=await fixture();expect(()=>f.owner.start({holdJobId:'uh-'+'b'.repeat(24)})).toThrow('non-ready');expect(f.prepare).not.toHaveBeenCalled();
  expect(()=>f.owner.start({holdJobId:f.holdJobId,targetQuad:[]})).toThrow();
  f.prepare.mockResolvedValueOnce({...f.value,handle:{...f.value.handle}});const ticket=f.owner.start({holdJobId:f.holdJobId});await turn();
  expect(await f.owner.get(ticket.jobId)).toMatchObject({state:'FAILED',error:expect.stringContaining('FACTORY')});
});
it('returns compact completed tickets, exact clone-only project geometry pages and keeps render/edit/art acceptance pending',async()=>{
  const f=await fixture(),ticket=f.owner.start({holdJobId:f.holdJobId});await turn();const ready=await f.owner.get(ticket.jobId);
  expect(ready).toMatchObject({state:'COMPLETED',result:{frameCount:24,focusHintsReady:false,artworkStatus:'ART_PENDING_CLAUDE'}});
  ready.result!.frameCount=999;const page=await f.owner.read(ticket.jobId,7,2);expect(page.items.map(r=>r.projectFrame)).toEqual([15,16]);expect(page.nextOffset).toBe(9);
  expect(page.nativePresentationVerified).toBe(false);expect(page.editableProjectGraphCompiled).toBe(false);expect(page.result!.frameCount).toBe(24);
  page.items[0].projected.projectQuad[0].x=999;expect((await f.owner.read(ticket.jobId,7,1)).items[0].projected.projectQuad[0].x).not.toBe(999);
  await expect(f.owner.read(ticket.jobId,0,33)).rejects.toThrow('PAGE_BUDGET');
});
it('rechecks current source/hold/project before publication and on every later ticket/page',async()=>{
  const f=await fixture();f.validateCurrent.mockRejectedValueOnce(Error('actual source changed'));const first=f.owner.start({holdJobId:f.holdJobId});await turn();
  expect(await f.owner.get(first.jobId)).toMatchObject({state:'FAILED',error:'actual source changed'});
  const ticket=f.owner.start({holdJobId:f.holdJobId});await turn();f.validateCurrent.mockRejectedValue(Error('current confirmed hold changed'));
  await expect(f.owner.get(ticket.jobId)).rejects.toThrow('hold changed');await expect(f.owner.read(ticket.jobId,0,1)).rejects.toThrow('hold changed');
});
it('keeps cancel/admission pending until the actual underlying process operation has settled (protocol mock)',async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),settled=Promise.withResolvers<LongformUiFocusGeometryOwnedV1>();
  f.prepare.mockImplementationOnce(async()=>{entered.resolve();return settled.promise;});const ticket=f.owner.start({holdJobId:f.holdJobId});await entered.promise;
  try{expect(f.owner.cancel(ticket.jobId).state).toBe('CANCELLING');expect((await f.owner.get(ticket.jobId)).state).toBe('CANCELLING');
    expect(()=>f.owner.start({holdJobId:f.holdJobId})).toThrow('ALREADY_RUNNING');await expect(f.owner.read(ticket.jobId,0,1)).rejects.toThrow('NOT_COMPLETED');
  }finally{settled.reject(Error('analysis-cancelled'));}await turn();expect((await f.owner.get(ticket.jobId)).state).toBe('CANCELLED');
});
it('close waits for the current operation and retires history; completed history is bounded to32 (protocol mock)',async()=>{
  const f=await fixture();let first='';for(let n=0;n<33;n++){const ticket=f.owner.start({holdJobId:f.holdJobId});first||=ticket.jobId;await turn();}
  await expect(f.owner.get(first)).rejects.toThrow('NOT_FOUND');
  const entered=Promise.withResolvers<void>(),settled=Promise.withResolvers<LongformUiFocusGeometryOwnedV1>();
  f.prepare.mockImplementationOnce(async()=>{entered.resolve();return settled.promise;});f.owner.start({holdJobId:f.holdJobId});await entered.promise;
  let closed=false;const close=f.owner.close().then(()=>{closed=true;});try{await turn();expect(closed).toBe(false);expect(()=>f.owner.start({holdJobId:f.holdJobId})).toThrow('JOBS_CLOSED');}
  finally{settled.reject(Error('analysis-cancelled'));}await close;expect(closed).toBe(true);
});
