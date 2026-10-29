import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {ImmutableDecodedPngFrameHolder, type ImmutablePngPlatform} from "./immutableDecodedPngFrame";

const png=()=>{const b=new Uint8Array(33);b.set([137,80,78,71,13,10,26,10]);new DataView(b.buffer).setUint32(8,13);b.set([73,72,68,82],12);new DataView(b.buffer).setUint32(16,2);new DataView(b.buffer).setUint32(20,2);return b;};
function setup() {
  let owned=true,next=0; const revoked:string[]=[],created:Blob[]=[];
  const platform:ImmutablePngPlatform={sha256:async b=>createHash("sha256").update(new Uint8Array(b)).digest("hex"),
    createObjectURL:b=>{created.push(b);return `blob:owned-${++next}`;},revokeObjectURL:u=>{revoked.push(u);},decode:async()=>({width:2,height:2})};
  const holder=new ImmutableDecodedPngFrameHolder({width:2,height:2},()=>owned,platform);
  const input=()=>{const bytes=png();return {pngBytes:Array.from(bytes),pngSha256:createHash("sha256").update(bytes).digest("hex"),pixelFnvHash:"fnv1a64:1234567890abcdef",width:2,height:2};};
  return {holder,platform,input,revoked,created,retire:()=>{owned=false;}};
}
describe("immutable whole-composition PNG publication",()=>{
  it("rejects changed full bytes before creating any URL",async()=>{const x=setup(),i=x.input();i.pngBytes[32]=1;await expect(x.holder.prepare(i,()=>true)).rejects.toThrow("SHA mismatch");expect(x.created).toHaveLength(0);x.holder.dispose();});
  it("keeps original blob bytes when native disk/transport slot is reused",async()=>{const x=setup(),i=x.input(),candidate=await x.holder.prepare(i,()=>true);i.pngBytes.fill(0);expect(await x.created[0].arrayBuffer()).toEqual(png().buffer);expect(x.holder.publish(candidate!,()=>true)?.url).toBe(candidate!.url);x.holder.acknowledgePresented(candidate!.url);x.holder.dispose();});
  it("publishes only after decode finishes",async()=>{const x=setup();let finish!:(v:{width:number;height:number})=>void;x.platform.decode=()=>new Promise(r=>{finish=r;});const pending=x.holder.prepare(x.input(),()=>true);await new Promise(r=>setTimeout(r,0));expect(x.created).toHaveLength(1);finish({width:2,height:2});const ready=await pending;expect(ready?.url).toBe("blob:owned-1");x.holder.dispose();});
  it("discards a superseded token even for A to B to A frame numbers",async()=>{const x=setup();let token=1,finish!:(v:{width:number;height:number})=>void;x.platform.decode=()=>new Promise(r=>{finish=r;});const pending=x.holder.prepare(x.input(),()=>token===1);await new Promise(r=>setTimeout(r,0));token=3;finish({width:2,height:2});expect(await pending).toBeUndefined();expect(x.revoked).toEqual(["blob:owned-1"]);x.holder.dispose();});
  it("rejects decoded canvas drift and revokes the exact candidate",async()=>{const x=setup();x.platform.decode=async()=>({width:3,height:2});await expect(x.holder.prepare(x.input(),()=>true)).rejects.toThrow("dimensions changed");expect(x.revoked).toEqual(["blob:owned-1"]);x.holder.dispose();});
  it("owner retirement hides a decoded old project",async()=>{const x=setup();let finish!:(v:{width:number;height:number})=>void;x.platform.decode=()=>new Promise(r=>{finish=r;});const pending=x.holder.prepare(x.input(),()=>true);await new Promise(r=>setTimeout(r,0));x.retire();finish({width:2,height:2});expect(await pending).toBeUndefined();expect(x.revoked).toEqual(["blob:owned-1"]);x.holder.dispose();});
  it("retires old URL only after the exact new DOM image load",async()=>{const x=setup(),a=await x.holder.prepare(x.input(),()=>true);x.holder.publish(a!,()=>true);expect(x.holder.acknowledgePresented(a!.url)).toBe(true);const b=await x.holder.prepare(x.input(),()=>true);x.holder.publish(b!,()=>true);expect(x.revoked).toEqual([]);expect(x.holder.acknowledgePresented(a!.url)).toBe(false);expect(x.revoked).toEqual([]);expect(x.holder.acknowledgePresented(b!.url)).toBe(true);expect(x.revoked).toEqual([a!.url]);x.holder.dispose();expect(x.revoked).toEqual([a!.url,b!.url]);});
  it("wrong URL load error cannot retire its successor",async()=>{const x=setup(),a=await x.holder.prepare(x.input(),()=>true);x.holder.publish(a!,()=>true);expect(x.holder.rejectPresentation("blob:other-owner")).toBe(false);expect(x.holder.isActive()).toBe(true);expect(x.holder.rejectPresentation(a!.url)).toBe(true);expect(x.holder.isActive()).toBe(false);expect(x.revoked).toEqual([a!.url]);});
});
