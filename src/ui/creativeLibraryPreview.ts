import type { CreativeLibraryAsset } from "../application/creativeLibrary";
export type PreviewMode = "poster" | "media";
export type PreviewResolver = (id: string, mode?: PreviewMode) => Promise<string>;
export type PreviewLease = {promise:Promise<string>;release:()=>void;invalidate:()=>boolean;generation:number};
export type LibraryKind = "all" | "broll" | "transition" | "motion" | "private_animation" | "audio" | "image";
export const LIBRARY_WINDOW_LIMIT = 8;
export function libraryAssetKind(asset: CreativeLibraryAsset): Exclude<LibraryKind,"all"> {
  if (asset.category === "private_animation" || asset.role === "private_animation") return "private_animation";
  if (["transition","transitions"].includes(asset.category) || ["transition","transitions"].includes(asset.role)) return "transition";
  if (asset.category === "broll") return "broll";
  return asset.mediaKind === "video" ? "motion" : asset.mediaKind;
}
export function libraryWindow<T>(items:T[],scrollTop:number,viewportHeight:number,rowHeight:number,limit=LIBRARY_WINDOW_LIMIT) {
  if(![scrollTop,viewportHeight,rowHeight,limit].every(Number.isFinite)||viewportHeight<0||rowHeight<=0||!Number.isSafeInteger(limit)||limit<1||limit>32)throw Error("Invalid library viewport");
  const count=Math.min(limit,Math.ceil(viewportHeight/rowHeight)+2);
  const start=Math.max(0,Math.min(Math.max(0,items.length-count),Math.floor(Math.max(0,scrollTop)/rowHeight)-1));
  const end=Math.min(items.length,start+count);
  return {start,end,items:items.slice(start,end),before:start*rowHeight,after:(items.length-end)*rowHeight};
}
export function shouldContainLibraryWheel(scrollTop:number,scrollHeight:number,clientHeight:number,deltaY:number):boolean {
  if(![scrollTop,scrollHeight,clientHeight,deltaY].every(Number.isFinite)||scrollHeight<=clientHeight||deltaY===0)return false;
  return deltaY<0?scrollTop>0:scrollTop+clientHeight<scrollHeight-1;
}
export function libraryWheelDeltaPixels(deltaY:number,deltaMode:number,clientHeight:number):number {
  if(![deltaY,deltaMode,clientHeight].every(Number.isFinite)||deltaY===0||clientHeight<0)return 0;
  if(deltaMode===1)return deltaY*16;
  if(deltaMode===2)return deltaY*Math.max(1,clientHeight);
  return deltaMode===0?deltaY:0;
}
export function moveLibraryViewportByWheel(viewport:Pick<HTMLElement,"scrollTop"|"scrollHeight"|"clientHeight">,deltaY:number):boolean {
  if(!Number.isFinite(deltaY)||deltaY===0)return false;
  const maximum=Math.max(0,viewport.scrollHeight-viewport.clientHeight);
  const next=Math.max(0,Math.min(maximum,viewport.scrollTop+deltaY));
  if(next===viewport.scrollTop)return false;
  viewport.scrollTop=next;
  return true;
}
export function handleLibraryViewportWheel(
  viewport:Pick<HTMLElement,"scrollTop"|"scrollHeight"|"clientHeight">,
  event:Pick<WheelEvent,"deltaY"|"deltaMode"|"preventDefault"|"stopPropagation">,
):boolean {
  const delta=libraryWheelDeltaPixels(event.deltaY,event.deltaMode,viewport.clientHeight);
  if(!moveLibraryViewportByWheel(viewport,delta))return false;
  event.preventDefault();event.stopPropagation();
  return true;
}
export function createAnimationFrameScrollCommit(
  commit:(scrollTop:number)=>void,
  requestFrame:(callback:FrameRequestCallback)=>number,
  cancelFrame:(handle:number)=>void,
) {
  let handle:number|undefined,pending=0,disposed=false;
  const flush=()=>{handle=undefined;if(!disposed)commit(pending);};
  return {
    push(scrollTop:number){
      if(disposed||!Number.isFinite(scrollTop))return;
      pending=Math.max(0,scrollTop);
      if(handle===undefined)handle=requestFrame(flush);
    },
    dispose(){disposed=true;if(handle!==undefined){cancelFrame(handle);handle=undefined;}},
  };
}
/** Bounded cache and work queue. Resolver identity prevents cross-runtime URL reuse. */
export function createLibraryPreviewCache(capacity=64, concurrency=2, queuedLimit=64) {
  if(!Number.isSafeInteger(capacity)||capacity<1||capacity>64||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>2||!Number.isSafeInteger(queuedLimit)||queuedLimit<1||queuedLimit>64)throw new Error("Invalid bounded preview cache limits");
  type Entry={promise:Promise<string>;refs:number;state:"queued"|"running"|"settled";start:()=>void;reject:(error:Error)=>void;key:string;generation:number};
  const resolvers=new WeakMap<PreviewResolver,number>(),cache=new Map<string,Entry>();
  const queue:Entry[]=[];let nextId=0,nextGeneration=0,running=0;
  const pump=()=>{while(running<concurrency&&queue.length){const entry=queue.shift()!;entry.state="running";running++;entry.start();}};
  const acquire=(resolver:PreviewResolver,id:string,revision:string,mode:PreviewMode):PreviewLease=>{
      if(!resolvers.has(resolver))resolvers.set(resolver,++nextId);
      const key=JSON.stringify([resolvers.get(resolver),id,revision,mode]),hit=cache.get(key);
      let entry=hit;
      if(hit){cache.delete(key);cache.set(key,hit);}
      else {
        if(queue.length>=queuedLimit)return {promise:Promise.reject<string>(new Error("預覽佇列已滿，請稍後重試")),release:()=>{},invalidate:()=>false,generation:0};
        let yes!:(url:string)=>void,no!:(error:Error)=>void;
        const promise=new Promise<string>((resolve,reject)=>{yes=resolve;no=reject;});
        entry={promise,refs:0,state:"queued",reject:no,key,generation:++nextGeneration,start:()=>{Promise.resolve().then(()=>resolver(id,mode)).then(yes,no).finally(()=>{entry!.state="settled";running--;pump();});}};
        queue.push(entry);cache.set(key,entry);while(cache.size>capacity)cache.delete(cache.keys().next().value!);
        const owned=entry;void promise.catch(()=>{if(cache.get(key)===owned)cache.delete(key);});
      }
      if(!entry)throw new Error("Missing preview cache entry");
      const owned=entry;owned.refs++;let released=false;pump();
      return {promise:owned.promise,generation:owned.generation,
        // Decode errors arrive after the resolver succeeded. The lease, not a
        // bare key, may evict that exact generation without harming newer work.
        invalidate:()=>{if(cache.get(key)!==owned)return false;cache.delete(key);return true;},
        release:()=>{if(released)return;released=true;owned.refs--;if(owned.refs===0&&owned.state==="queued"){const index=queue.indexOf(owned);if(index>=0)queue.splice(index,1);owned.state="settled";if(cache.get(key)===owned)cache.delete(key);owned.reject(new Error("預覽已離開可見範圍"));}}};
  };
  return {
    acquire,
    resolve(resolver:PreviewResolver,id:string,revision:string,mode:PreviewMode){const lease=acquire(resolver,id,revision,mode);void lease.promise.then(lease.release,lease.release);return lease.promise;},
    stats:()=>({running,queued:queue.length,cached:cache.size}),
  };
}
export const libraryPreviewCache=createLibraryPreviewCache();

/** Unsubscribing invalidates both success and failure after a hover/page/unmount race. */
export function subscribeLibraryPreview(request:Promise<string>|{promise:Promise<string>;release:()=>void},success:(url:string)=>void,failure:()=>void) {
  const pending=request instanceof Promise?request:request.promise;
  let current=true;
  void pending.then(url=>{if(current)success(url);},()=>{if(current)failure();});
  return ()=>{current=false;if(!(request instanceof Promise))request.release();};
}
