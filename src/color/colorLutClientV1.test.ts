import { describe,expect,it,vi } from "vitest";
import { createHash } from "node:crypto";
import { createColorLutClientV1 } from "./colorLutClientV1";
import { parseCubeFile,sampleCubeLut } from "./cubeLut";
const text='\ufeffTITLE "Own warm"\nLUT_3D_SIZE 2\n'+[0,1].flatMap(b=>[0,1].flatMap(g=>[0,1].map(r=>`${.05+.9*r} ${g} ${.8*b}`))).join('\n')+'\n',sha=createHash('sha256').update(text).digest('hex');
const entry={id:'lut:'+sha.slice(0,16),sha256:sha,name:'Own',kind:'3d' as const,size:2,bytes:Buffer.byteLength(text),path:`luts/${sha}.cube`,license:'CC0',provenance:'Own',rightsBasis:'owner-authored',inputSpace:'rec709_display' as const,importedAt:'2026-10-14'},ref={id:entry.id,sha256:sha,strength:.5};
function setup(){const api={listColorLutsV1:vi.fn(async()=>({entries:[entry],total:1})),pickColorLutV1:vi.fn(async()=>({selectionId:'1'.repeat(32),suggestedName:'Own'})),importColorLutV1:vi.fn(async()=>({entry,nodeReference:ref})),readColorLutV1:vi.fn(async()=>text)};return{api,client:createColorLutClientV1(api)}}
describe('one verified read path for apply, GPU and cube export',()=>{
  it('preserves BOM/fullSHA, deduplicates only pending reads and re-verifies after settlement',async()=>{
    const{api,client}=setup();const [a,b]=await Promise.all([client.read(ref,'rec709_display'),client.read(ref,'rec709_display')]);expect(a).toBe(text);expect(b).toBe(text);expect(api.readColorLutV1).toHaveBeenCalledTimes(1);await client.read(ref,'rec709_display');expect(api.readColorLutV1).toHaveBeenCalledTimes(2);
  });
  it('refuses corrupted bytes and known-hash malformed cube',async()=>{
    const{api,client}=setup();api.readColorLutV1.mockResolvedValue('corrupt');await expect(client.read(ref,'rec709_display')).rejects.toThrow(/不符/);
    const bad='not a cube',hash=createHash('sha256').update(bad).digest('hex');api.readColorLutV1.mockResolvedValue(bad);await expect(client.read({id:'lut:'+hash.slice(0,16),sha256:hash,strength:1},'rec709_display')).rejects.toThrow();
  });
  it('validates metadata pages and picker/import replies',async()=>{
    const{api,client}=setup();expect((await client.list()).entries).toEqual([entry]);expect(await client.pick()).toEqual({selectionId:'1'.repeat(32),suggestedName:'Own'});
    api.listColorLutsV1.mockResolvedValue({entries:Array(101).fill(entry),total:101});await expect(client.list()).rejects.toThrow(/metadata/);
    api.importColorLutV1.mockResolvedValue({entry,nodeReference:{...ref,sha256:'0'.repeat(64)}});await expect(client.import({selectionId:'1'.repeat(32),name:'Own',license:'CC0',provenance:'Own',rightsBasis:'owner-authored',inputSpace:'rec709_display'})).rejects.toThrow();
  });
  it('exports the same complete v2 LUT-node blend through the existing65cube math',async()=>{
    const{client}=setup(),result=await client.exportGrade({schema:'editkin.color-grade/v2',nodes:[{id:'n',lut:ref}]},'rec709_display','Owned export'),cube=parseCubeFile(result.text),rgb=[.3,.4,.7] as [number,number,number],actual=sampleCubeLut(cube,rgb);
    expect(actual[0]).toBeCloseTo(.95*rgb[0]+.025,5);expect(actual[1]).toBeCloseTo(rgb[1],5);expect(actual[2]).toBeCloseTo(.9*rgb[2],5);expect(result.size).toBe(65);
  });
});
