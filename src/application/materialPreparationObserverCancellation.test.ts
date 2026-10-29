import { describe, expect, it } from "vitest";
import { MaterialPreparationWorkPool } from "./materialEvidenceCache";
function gate<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function terminal<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<"OBSERVATION_DEADLINE">(r=>{timer=setTimeout(()=>r("OBSERVATION_DEADLINE"),100);})]);}finally{clearTimeout(timer);}}
describe("parent integration review: progress cancellation and snapshot ownership",()=>{
  it("accepts an ordinary source-work result and idempotent final release",async()=>{
    const pool=new MaterialPreparationWorkPool<{ok:boolean}>();const lease=pool.acquire("ordinary",async()=>({ok:true}));
    expect(await lease.result).toEqual({ok:true});await lease.release();await lease.release();expect(pool.snapshot()).toMatchObject({entries:0,active:0,leases:0,retainedBytes:0});
  });
  it("final cancellation closes the producer even if its observer never settles",async()=>{
    const pool=new MaterialPreparationWorkPool<number,{phase:string}>(),entered=gate(),controller=new AbortController();let closed=false;
    const lease=pool.acquire("last",async(signal,progress)=>{try{await progress({phase:"scene"});signal.throwIfAborted();return 1;}finally{closed=true;}},{signal:controller.signal,onProgress:()=>{entered.resolve();return new Promise(()=>undefined);}});
    await entered.promise;controller.abort();expect(await terminal(lease.release().then(()=>"CLOSED"))).toBe("CLOSED");expect(closed).toBe(true);
    expect(pool.snapshot()).toMatchObject({entries:0,active:0,leases:0});await expect(lease.result).rejects.toThrow();
  });
  it("canceling a hung observer cannot block a surviving peer or abort its shared work",async()=>{
    const pool=new MaterialPreparationWorkPool<number,{phase:string}>(),entered=gate(),controller=new AbortController();let starts=0,closed=false;
    const first=pool.acquire("peer",async(signal,progress)=>{starts++;try{await Promise.resolve();await progress({phase:"scene"});signal.throwIfAborted();return 7;}finally{closed=true;}},{signal:controller.signal,onProgress:()=>{entered.resolve();return new Promise(()=>undefined);}});
    const peer=pool.acquire("peer",async()=>{throw Error("DUPLICATE_PRODUCER");});await entered.promise;controller.abort();await first.release();
    expect(await terminal(peer.result)).toBe(7);expect(starts).toBe(1);expect(closed).toBe(true);await peer.release();expect(pool.snapshot()).toMatchObject({entries:0,active:0,leases:0});
  });
  it("caller mutation cannot change a retained result or the next lease's result",async()=>{
    const pool=new MaterialPreparationWorkPool<{count:number}>(),value={count:1};const a=pool.acquire("value",async()=>value),b=pool.acquire("value",async()=>({count:99}));
    const first=await a.result,second=await b.result;first.count=8;value.count=9;
    const c=pool.acquire("value",async()=>({count:99}));expect(second.count).toBe(1);expect((await c.result).count).toBe(1);
    await a.release();await b.release();await c.release();expect(pool.snapshot().entries).toBe(0);
  });
  it("one observer cannot mutate another observer's progress snapshot",async()=>{
    const pool=new MaterialPreparationWorkPool<number,{phase:string}>(),seen:string[]=[];
    const first=pool.acquire("progress",async(_signal,progress)=>{await Promise.resolve();await progress({phase:"scene"});return 1;},{onProgress:p=>{p.phase="FAKE";}});
    const peer=pool.acquire("progress",async()=>99,{onProgress:p=>{seen.push(p.phase);}});await Promise.all([first.result,peer.result]);expect(seen).toEqual(["scene"]);
    await first.release();await peer.release();expect(pool.snapshot().entries).toBe(0);
  });
});
