import {describe,it,expect,vi} from "vitest";
import {createAnimationFrameScrollCommit,createLibraryPreviewCache,handleLibraryViewportWheel,libraryAssetKind,libraryWheelDeltaPixels,libraryWindow,moveLibraryViewportByWheel,shouldContainLibraryWheel,subscribeLibraryPreview,type PreviewResolver} from "./creativeLibraryPreview";
import type {CreativeLibraryAsset} from "../application/creativeLibrary";
const asset=(category:string,role="support",mediaKind:CreativeLibraryAsset["mediaKind"]="video")=>({id:category,name:category,category,role,mediaKind,domains:[],bytes:1,license:"fixture",provenance:"fixture"});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
describe("bounded library reachability and truthful taxonomy",()=>{
 it("reaches all841 items by continuous scroll with <=8 mounted and exact spacers",()=>{const rows=Array.from({length:841},(_,i)=>i),seen=new Set<number>();for(let top=0;top<rows.length*320;top+=160){const w=libraryWindow(rows,top,640,320);expect(w.items.length).toBeLessThanOrEqual(8);expect(w.before+w.items.length*320+w.after).toBe(841*320);for(const i of w.items)seen.add(i);}expect([...seen]).toEqual(rows);expect(libraryWindow([],0,640,320).items).toEqual([]);expect(libraryWindow(rows,-10,640,320).start).toBe(0);expect(libraryWindow(rows,9999999,640,320).items.at(-1)).toBe(840);});
 it("clamps a retained scroll position when filtering to a small result",()=>{expect(libraryWindow([1,2],80000,640,320)).toMatchObject({start:0,end:2,items:[1,2],before:0,after:0});expect(()=>libraryWindow([],0,500,0)).toThrow();});
 it("contains vertical wheel input only while the library can move in that direction",()=>{expect(shouldContainLibraryWheel(0,1000,400,120)).toBe(true);expect(shouldContainLibraryWheel(600,1000,400,120)).toBe(false);expect(shouldContainLibraryWheel(600,1000,400,-120)).toBe(true);expect(shouldContainLibraryWheel(0,1000,400,-120)).toBe(false);expect(shouldContainLibraryWheel(0,300,400,120)).toBe(false);});
 it("normalizes WebView wheel units and explicitly moves the virtualized viewport",()=>{
  expect(libraryWheelDeltaPixels(3,1,246)).toBe(48);
  expect(libraryWheelDeltaPixels(1,2,246)).toBe(246);
  expect(libraryWheelDeltaPixels(420,0,246)).toBe(420);
  const viewport={scrollTop:0,scrollHeight:142442,clientHeight:246};
  expect(moveLibraryViewportByWheel(viewport,420)).toBe(true);
  expect(viewport.scrollTop).toBe(420);
  viewport.scrollTop=viewport.scrollHeight-viewport.clientHeight;
  expect(moveLibraryViewportByWheel(viewport,420)).toBe(false);
  expect(moveLibraryViewportByWheel(viewport,-420)).toBe(true);
  viewport.scrollTop=0;
  const event={deltaY:420,deltaMode:0,preventDefault:vi.fn(),stopPropagation:vi.fn()};
  expect(handleLibraryViewportWheel(viewport,event)).toBe(true);
  expect(viewport.scrollTop).toBe(420);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
 });
 it("coalesces scroll state to one commit per animation frame and cancels disposed work",()=>{
  const callbacks=new Map<number,FrameRequestCallback>(),commits:number[]=[];let next=0;
  const queue=createAnimationFrameScrollCommit(value=>commits.push(value),callback=>{callbacks.set(++next,callback);return next;},handle=>{callbacks.delete(handle);});
  queue.push(12);queue.push(80);queue.push(420);
  expect(callbacks.size).toBe(1);expect(commits).toEqual([]);
  callbacks.get(1)?.(16);callbacks.delete(1);
  expect(commits).toEqual([420]);
  queue.push(512);expect(callbacks.size).toBe(1);queue.dispose();expect(callbacks.size).toBe(0);
  queue.push(900);expect(commits).toEqual([420]);
 });
 it("allows the compact project list to request a separately bounded larger window",()=>{expect(libraryWindow(Array.from({length:100},(_,i)=>i),0,760,76,16).items).toHaveLength(12);expect(()=>libraryWindow([],0,500,100,33)).toThrow();});
 it("separates footage from transition/showcase and private animation",()=>{expect(libraryAssetKind(asset("broll"))).toBe("broll");expect(libraryAssetKind(asset("motion","transition"))).toBe("transition");expect(libraryAssetKind(asset("transitions"))).toBe("transition");expect(libraryAssetKind(asset("motion","template_showcase"))).toBe("motion");expect(libraryAssetKind(asset("private_animation"))).toBe("private_animation");});
});
describe("preview cache and concurrency",()=>{
 it("releases obsolete queued leases without starting resolvers and keeps active work bounded",async()=>{
  const cache=createLibraryPreviewCache(),started:string[]=[],finish:Array<(value:string)=>void>=[];
  const resolver:PreviewResolver=id=>{started.push(id);return new Promise(resolve=>finish.push(resolve));};
  const first=cache.acquire(resolver,"running-a","r","poster"),second=cache.acquire(resolver,"running-b","r","poster");
  const obsolete=Array.from({length:64},(_,i)=>cache.acquire(resolver,`obsolete-${i}`,"r","poster"));
  for(const lease of obsolete){void lease.promise.catch(()=>{});lease.release();lease.release();}
  expect(cache.stats()).toMatchObject({running:2,queued:0});
  const final=cache.acquire(resolver,"visible-final","r","poster");await flush();expect(started).toEqual(["running-a","running-b"]);
  first.release();second.release();expect(cache.stats().running).toBe(2);finish[0]!("a");await flush();expect(started).toEqual(["running-a","running-b","visible-final"]);
  finish[1]!("b");finish[2]!("final");expect(await final.promise).toBe("final");final.release();await flush();expect(cache.stats()).toMatchObject({running:0,queued:0});
 });
 it("does not cancel a shared queued request until its last subscriber releases",async()=>{
  const cache=createLibraryPreviewCache(64,1);let done!:(value:string)=>void;const resolver=vi.fn((id:string)=>id==="block"?new Promise<string>(resolve=>done=resolve):Promise.resolve(id));
  const blocker=cache.acquire(resolver,"block","r","poster"),a=cache.acquire(resolver,"shared","r","poster"),b=cache.acquire(resolver,"shared","r","poster");expect(a.promise).toBe(b.promise);a.release();expect(cache.stats().queued).toBe(1);await flush();done("block");expect(await b.promise).toBe("shared");expect(resolver.mock.calls.map(x=>x[0])).toEqual(["block","shared"]);blocker.release();b.release();
 });
 it("effect unsubscribe releases queued work and suppresses cancellation errors",async()=>{
  const cache=createLibraryPreviewCache(64,1);let finish!:(value:string)=>void;const block=cache.acquire(()=>new Promise<string>(resolve=>finish=resolve),"block","r","poster");const resolve=vi.fn(async()=>"stale"),success=vi.fn(),failure=vi.fn();const cancel=subscribeLibraryPreview(cache.acquire(resolve,"obsolete","r","poster"),success,failure);cancel();await flush();finish("done");await block.promise;block.release();await flush();expect(resolve).not.toHaveBeenCalled();expect(success).not.toHaveBeenCalled();expect(failure).not.toHaveBeenCalled();
 });
 it("cancels late success/failure on hover change and unmount",async()=>{let oldResolve!:(s:string)=>void,newResolve!:(s:string)=>void,fail!:(e:Error)=>void;const success=vi.fn(),error=vi.fn();const cancel=subscribeLibraryPreview(new Promise(r=>oldResolve=r),success,error);cancel();subscribeLibraryPreview(new Promise(r=>newResolve=r),success,error);newResolve("new");oldResolve("stale");const unmount=subscribeLibraryPreview(new Promise((_,r)=>fail=r),success,error);unmount();fail(Error("late"));await flush();expect(success.mock.calls).toEqual([["new"]]);expect(error).not.toHaveBeenCalled();});
 it("binds resolver identity, revision and poster/media independently",async()=>{const c=createLibraryPreviewCache(),a=vi.fn(async(id:string,mode?:string)=>`A:${id}:${mode}`),b=vi.fn(async()=>"B");expect(await c.resolve(a,"same","r1","poster")).toBe("A:same:poster");expect(await c.resolve(b,"same","r1","poster")).toBe("B");await c.resolve(a,"same","r2","poster");await c.resolve(a,"same","r1","media");await c.resolve(a,"same","r1","poster");expect(a).toHaveBeenCalledTimes(3);expect(b).toHaveBeenCalledTimes(1);});
 it("limits running requests to2 and deduplicates identical pending work",async()=>{const c=createLibraryPreviewCache(),releases:Array<(s:string)=>void>=[];const resolver:PreviewResolver=vi.fn(()=>new Promise<string>(resolve=>releases.push(resolve)));const first=c.resolve(resolver,"a","r","poster");expect(c.resolve(resolver,"a","r","poster")).toBe(first);const second=c.resolve(resolver,"b","r","poster"),third=c.resolve(resolver,"c","r","poster");await flush();expect(releases.length).toBe(2);expect(c.stats()).toMatchObject({running:2,queued:1});releases[0]!("a");await first;await flush();expect(releases.length).toBe(3);expect(c.stats().running).toBe(2);releases[1]!("b");releases[2]!("c");await Promise.all([second,third]);await flush();expect(c.stats().running).toBe(0);});
 it("bounds queue saturation and releases failed cached requests for retry",async()=>{const c=createLibraryPreviewCache(2,1,1);let release!:(s:string)=>void;const pending:PreviewResolver=()=>new Promise(r=>release=r);const a=c.resolve(pending,"a","r","poster"),b=c.resolve(async()=>"b","b","r","poster");await expect(c.resolve(async()=>"c","c","r","poster")).rejects.toThrow(/佇列/);await flush();release("a");await Promise.all([a,b]);const failing=vi.fn().mockRejectedValueOnce(Error("failed")).mockResolvedValue("ok");await expect(c.resolve(failing,"retry","r","poster")).rejects.toThrow("failed");expect(await c.resolve(failing,"retry","r","poster")).toBe("ok");});
 it("evicts least-recently-used entries and rejects unbounded settings",async()=>{const c=createLibraryPreviewCache(2),resolver=vi.fn(async id=>id);await c.resolve(resolver,"a","r","media");await c.resolve(resolver,"b","r","media");await c.resolve(resolver,"a","r","media");await c.resolve(resolver,"c","r","media");await c.resolve(resolver,"b","r","media");expect(resolver).toHaveBeenCalledTimes(4);expect(c.stats().cached).toBe(2);expect(()=>createLibraryPreviewCache(65)).toThrow();expect(()=>createLibraryPreviewCache(2,3)).toThrow();});
});
