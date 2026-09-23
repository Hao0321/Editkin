import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks=vi.hoisted(()=>({values:[] as any[],cursor:0,effects:[] as Array<()=>void|(()=>void)>}));
vi.mock("react",()=>({
  useState:(initial:unknown)=>{const slot=hooks.cursor++;if(!(slot in hooks.values))hooks.values[slot]=typeof initial==="function"?initial():initial;return[hooks.values[slot],(value:any)=>{hooks.values[slot]=typeof value==="function"?value(hooks.values[slot]):value;}];},
  useRef:(current:unknown)=>{const slot=hooks.cursor++;return hooks.values[slot]??(hooks.values[slot]={current});},
  useEffect:(effect:()=>void|(()=>void))=>{hooks.effects.push(effect);},
}));
import CreativePreviewTile from "./CreativePreviewTile";
import { libraryPreviewCache } from "./creativeLibraryPreview";
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function find(node:any,type:string):any {if(!node||typeof node!=="object")return;if(node.type===type)return node;for(const child of[node.props?.children].flat(Infinity)){const found=find(child,type);if(found)return found;}}
function findButton(node:any,text:string):any {if(!node||typeof node!=="object")return;if(node.type==="button"&&node.props?.children===text)return node;for(const child of[node.props?.children].flat(Infinity)){const found=findButton(child,text);if(found)return found;}}
function fixture(active=false,sameUrl=false,visible=true) {
  // Declared IntersectionObserver state only; no synthetic DOM geometry.
  hooks.values[2]=visible;
  let media=0,poster=0;
  const resolver=vi.fn(async(_id:string,mode?:string)=>mode==="poster"?`poster:${sameUrl?"same":++poster}`:`media:${sameUrl?"same":++media}`);
  const props={asset:{id:"fixture:tile",name:"Fixture",category:"broll",role:"support",domains:[],mediaKind:"video" as const,bytes:1,license:"fixture",provenance:"fixture",preview:{poster:true,motion:true,revision:"r"}},revision:"pack:1",active,playing:false,resolve:resolver,onActivate:vi.fn(),onDeactivate:vi.fn()};
  const render=()=>{hooks.cursor=0;hooks.effects=[];return CreativePreviewTile(props);};
  const cleanups=new Map<number,()=>void>();
  const run=(index:number)=>{cleanups.get(index)?.();const cleanup=hooks.effects[index]!();if(cleanup)cleanups.set(index,cleanup);};
  const retry=async(node:any)=>{findButton(node,"重試").props.onClick();render();run(3);if(props.active)run(4);await flush();return render();};
  return{props,resolver,render,run,retry};
}
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.effects=[];});

describe("actual tile callbacks/effects with deterministic hook lifecycle (not browser decode)",()=>{
  it("attempts a poster for legacy video metadata instead of waiting forever",async()=>{
    const f=fixture();delete (f.props.asset as {preview?:unknown}).preview;
    f.render();f.run(3);await flush();const node=f.render();
    expect(f.resolver.mock.calls.map(call=>call[1])).toEqual(["poster"]);
    expect(find(node,"img").props.src).toBe("poster:1");
  });
  it("does not offer a dead play button when a pack declares no preview",()=>{
    const f=fixture();f.props.asset.preview.poster=false;f.props.asset.preview.motion=false;
    const node=f.render();f.run(3);f.run(4);
    expect(f.resolver).not.toHaveBeenCalled();expect(find(node,"button")).toBeUndefined();
    expect(find(node,"b").props.children).toBe("這份素材未提供預覽");
  });
  it("loads and renders the bounded mounted-window poster before IntersectionObserver reports visibility",async()=>{
    const f=fixture(false,false,false);f.render();f.run(3);await flush();const node=f.render();
    expect(f.resolver.mock.calls.map(call=>call[1])).toEqual(["poster"]);
    expect(find(node,"img").props).toMatchObject({src:"poster:1",loading:"eager",decoding:"async"});
    expect(find(node,"span")).toBeUndefined();
  });
  it("loads only the stable poster until the explicit play control is used",async()=>{
    const f=fixture(false);let node=f.render();f.run(3);f.run(4);await flush();node=f.render();
    expect(f.resolver.mock.calls.map(call=>call[1])).toEqual(["poster"]);
    expect(node.props.onPointerEnter).toBeUndefined();
    const play=find(node,"button");expect(play.props["aria-label"]).toContain("播放 Fixture");play.props.onClick();expect(f.props.onActivate).toHaveBeenCalledWith("fixture:tile");
    f.props.active=true;f.render();f.run(4);await flush();expect(f.resolver.mock.calls.map(call=>call[1])).toEqual(["poster","media"]);
  });
  it("poster error→Retry resolves again and displays the repaired source",async()=>{
    const f=fixture();f.render();f.run(3);await flush();let node=f.render();
    expect(find(node,"img").props.src).toBe("poster:1");find(node,"img").props.onError();node=f.render();
    expect(find(node,"button").props.children).toBe("重試");node=await f.retry(node);
    expect(find(node,"img").props.src).toBe("poster:2");expect(f.resolver).toHaveBeenCalledTimes(2);
  });
  it("a same-URL retry remounts the image with a fresh generation",async()=>{
    const f=fixture(false,true);f.render();f.run(3);await flush();let node=f.render();const previous=find(node,"img");
    previous.props.onError();node=await f.retry(f.render());const current=find(node,"img");
    expect(current.props.src).toBe(previous.props.src);expect(current.key).not.toBe(previous.key);expect(f.resolver).toHaveBeenCalledTimes(2);
  });
  it("media retry leaves poster cached; stale old error cannot invalidate the new generation",async()=>{
    const f=fixture(true);f.render();f.run(3);f.run(4);await flush();let node=f.render();const previous=find(node,"video"),oldError=previous.props.onError;
    oldError();node=await f.retry(f.render());const current=find(node,"video");
    expect(current.props.src).toBe("media:2");expect(current.key).not.toBe(previous.key);
    oldError();expect(findButton(f.render(),"重試")).toBeUndefined();
    expect(await libraryPreviewCache.resolve(f.resolver,f.props.asset.id,"pack:1:r","media")).toBe("media:2");
    expect(await libraryPreviewCache.resolve(f.resolver,f.props.asset.id,"pack:1:r","poster")).toBe("poster:1");
    expect(f.resolver.mock.calls.map(call=>call[1])).toEqual(["poster","media","media"]);
  });
});
