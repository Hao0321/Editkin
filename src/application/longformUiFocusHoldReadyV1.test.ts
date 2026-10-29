import {afterEach,it,expect,vi} from "vitest";
import {LongformUiFocusConfirmationsV1,LongformUiFocusHoldJobsV1} from "./longformUiFocusHoldJobsV1";
import {uiFocusGeometryJobFixtureV1} from "./longformUiFocusGeometryJobsV1.fixture";
import {colorDigest} from "./materialColorSamplingRuntime";
const owners:LongformUiFocusHoldJobsV1[]=[];afterEach(async()=>{await Promise.all(owners.splice(0).map(o=>o.close()));});
const turn=()=>new Promise<void>(done=>setImmediate(done));
async function fixture(){const f=await uiFocusGeometryJobFixtureV1(),confirmations=new LongformUiFocusConfirmationsV1();let viewed=true;
  confirmations.rememberVerified(f.artifact.artifactId,[f.result.candidateId]);const validateCurrent=vi.fn(async()=>{}),prepare=vi.fn(async()=>structuredClone(f.result));
  const owner=new LongformUiFocusHoldJobsV1({assertOwned:id=>{if(id!==f.artifact.artifactId)throw Error('foreign artifact');},
    assertViewed:()=>{if(!viewed)throw Error('source view revoked');},confirmations,read:async()=>f.artifact,prepare,validateCurrent});owners.push(owner);
  return{...f,owner,confirmations,prepare,validateCurrent,revokeView:()=>{viewed=false;}};}
it('derives ready result only from this actual owner row, keeps result cloned and rechecks current source/view after use',async()=>{
  const f=await fixture(),ticket=f.owner.start(f.request),callback=vi.fn(async()=>{});
  expect(()=>f.owner.assertReadyOwned(ticket.jobId)).toThrow('READY_OWNED');await turn();
  expect(()=>f.owner.assertReadyOwned('uh-'+'a'.repeat(24))).toThrow('NOT_FOUND');
  const calls=f.validateCurrent.mock.calls.length;
  await f.owner.withReadyResult(ticket.jobId,async(hold,validate,artifact)=>{expect(hold.receiptSha256).toBe(f.result.receiptSha256);
    expect(artifact.artifactId).toBe(f.artifact.artifactId);artifact.project.clipId='external mutation';hold.frames[0].targetQuad[0].x=999;await validate();return'used';});
  expect(f.validateCurrent.mock.calls.length-calls).toBe(3);expect((await f.owner.read(ticket.jobId,0,1)).items[0].targetQuad[0].x).not.toBe(999);
  f.revokeView();await expect(f.owner.withReadyResult(ticket.jobId,callback)).rejects.toThrow('view revoked');expect(callback).not.toHaveBeenCalled();
});
it('refuses blocked evidence and a source/provider revocation before or during a ready operation',async()=>{
  const f=await fixture(),blocked=structuredClone(f.result);blocked.state='BLOCKED';blocked.flags=['LOCAL_TARGET_MISSING'];blocked.pixelTemplateContinuityVerified=false;
  const{receiptSha256:_seal,...body}=blocked;blocked.receiptSha256=colorDigest(body);f.prepare.mockResolvedValueOnce(blocked);
  const blockedTicket=f.owner.start(f.request);await turn();expect(()=>f.owner.assertReadyOwned(blockedTicket.jobId)).toThrow('READY_OWNED');
  const ticket=f.owner.start(f.request);await turn();
  await expect(f.owner.withReadyResult(ticket.jobId,async()=>{f.validateCurrent.mockRejectedValue(Error('actual source changed'));})).rejects.toThrow('actual source changed');
  f.validateCurrent.mockResolvedValue();await expect(f.owner.withReadyResult(ticket.jobId,async()=>{f.confirmations.clear();})).rejects.toThrow('CONFIRM_TARGET_FIRST');
});
it('refuses cancelled or retired owner operations and honors an abort before callback ingress',async()=>{
  const f=await fixture(),ticket=f.owner.start(f.request);await turn();const signal=AbortSignal.abort();
  await expect(f.owner.withReadyResult(ticket.jobId,async()=>{},signal)).rejects.toThrow();
  await expect(f.owner.withReadyResult(ticket.jobId,async()=>{await f.owner.close();})).rejects.toThrow('JOBS_CLOSED');
});
