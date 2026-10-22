import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { desktopColorLutLibraryV1 } from "./colorLutDesktopLibraryV1";
import { importColorLut, listColorLuts, resolveColorLut } from "./creativeLibrary";
const cube = 'TITLE "Owned warm"\nLUT_3D_SIZE 2\n' + [0,1].flatMap(b => [0,1].flatMap(g => [0,1].map(r => `${.05+.9*r} ${g} ${.8*b}`))).join('\n')+'\n';
const rights = { name: "Owned LUT", license: "CC0-1.0", provenance: "Own diagnostic fixture", rightsBasis: "owner-authored", inputSpace: "rec709_display" as const };
let root: string, library: string, source: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(),"editkin-desktop-lut-v1-")); library=join(root,"library"); source=join(root,"own.cube"); await writeFile(source,cube); });
afterEach(async () => { await rm(root,{recursive:true,force:true}); });
const call = (payload: unknown) => desktopColorLutLibraryV1(library,payload);
const importing = () => call({operation:"import",sourcePath:source,...rights});
describe("desktop personal LUT boundary", () => {
  it("reads empty without creating a library, then shares exact bytes/rights/ID with the existing importer and render resolver",async()=>{
    expect(await call({operation:"list"})).toEqual({entries:[],total:0});expect(await readdir(root)).toEqual(["own.cube"]);
    const result=await importing(); expect('entry' in result).toBe(true);const entry=(result as any).entry;
    expect(await readFile(join(library,entry.path),"utf8")).toBe(cube);expect(entry.sha256).toBe(createHash("sha256").update(cube).digest("hex"));
    expect(await listColorLuts(library)).toEqual([entry]);expect((await resolveColorLut(library,entry.id,entry.sha256)).cube.kind).toBe("3d");
    expect(await importColorLut(library,{sourcePath:source,...rights})).toEqual(entry);
    expect(await call({operation:"resolve",id:entry.id,sha256:entry.sha256,inputSpace:"rec709_display"})).toEqual({entry,absolutePath:join(library,entry.path)});
    expect((await readdir(library)).some(n=>n.startsWith('.desktop-import-'))).toBe(false);
  });
  it("keeps both concurrent imports and returns stable pages without duplicate writes",async()=>{
    const other=join(root,"other.cube");await writeFile(other,"LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
    await Promise.all([importing(),call({operation:"import",sourcePath:other,...rights,name:"Second"})]);
    const page=await call({operation:"list",offset:0,limit:1}) as any,next=await call({operation:"list",offset:page.nextOffset,limit:1}) as any;
    expect(page.total).toBe(2);expect(next.total).toBe(2);expect(page.entries[0].id).not.toBe(next.entries[0].id);expect(next.nextOffset).toBeUndefined();
    const before=await readFile(join(library,"editkin-color-luts.json"));await importing();expect(await readFile(join(library,"editkin-color-luts.json"))).toEqual(before);
  });
  it.each([{license:""},{rightsBasis:""},{provenance:""},{name:"bad\nname"},{force:true}])("refuses invalid rights/schema before any library write: %j",async patch=>{
    await expect(call({operation:"import",sourcePath:source,...rights,...patch})).rejects.toThrow();expect(await readdir(root)).toEqual(["own.cube"]);
  });
  it("refuses relative, non-cube, malformed and over64MiB sources before creating the library",async()=>{
    await expect(call({operation:"import",sourcePath:"own.cube",...rights})).rejects.toThrow(/路徑/);
    const txt=join(root,"own.txt");await writeFile(txt,cube);await expect(call({operation:"import",sourcePath:txt,...rights})).rejects.toThrow(/\.cube/);
    await writeFile(source,"LUT_3D_SIZE 2\n0 0 0\n");await expect(importing()).rejects.toThrow(/不完整/);
    await truncate(source,64*1024*1024+1);await expect(importing()).rejects.toThrow(/64 MiB/);expect((await readdir(root)).includes('library')).toBe(false);
  });
  it("refuses altered bytes, wrong SHA/space and conflicting re-import without altering metadata",async()=>{
    const entry=(await importing() as any).entry,before=await readFile(join(library,"editkin-color-luts.json")),ref={operation:"resolve",id:entry.id,sha256:entry.sha256,inputSpace:"rec709_display"};
    await expect(call({...ref,inputSpace:"acescct"})).rejects.toThrow(/不符/);await expect(call({...ref,sha256:'0'.repeat(64)})).rejects.toThrow();
    await expect(call({operation:"import",sourcePath:source,...rights,license:"Another license"})).rejects.toThrow(/不同授權/);expect(await readFile(join(library,"editkin-color-luts.json"))).toEqual(before);
    await writeFile(join(library,entry.path),cube.replace("0.05","0.06"));await expect(call(ref)).rejects.toThrow(/不符/);await expect(importing()).rejects.toThrow(/不符/);expect(await readFile(join(library,"editkin-color-luts.json"))).toEqual(before);
  });
  it("refuses library junction escape and source parent junction",async()=>{
    const outside=join(root,"outside"),link=join(root,"linked");await mkdir(outside);await symlink(outside,link,process.platform==='win32'?'junction':'dir');
    await expect(desktopColorLutLibraryV1(join(link,"library"),{operation:"list"})).rejects.toThrow(/連結/);
    await writeFile(join(outside,"own.cube"),cube);await expect(call({operation:"import",sourcePath:join(link,"own.cube"),...rights})).rejects.toThrow(/連結/);
    expect(await readdir(outside)).toEqual(["own.cube"]);
  });
  it("refuses corrupt orphan and oversized metadata, preserving preexisting bytes",async()=>{
    const sha=createHash("sha256").update(cube).digest("hex"),target=join(library,"luts",`${sha}.cube`);await mkdir(join(library,"luts"),{recursive:true});await writeFile(target,"corrupt");
    await expect(importing()).rejects.toThrow(/不符/);expect(await readFile(target,"utf8")).toBe("corrupt");expect((await readdir(library)).includes("editkin-color-luts.json")).toBe(false);
    const meta=join(library,"editkin-color-luts.json");await writeFile(meta,'{}');await truncate(meta,8*1024*1024+1);await expect(call({operation:"list"})).rejects.toThrow(/8 MiB/);
  });
  it("refuses metadata growth before indexing or writing a new LUT",async()=>{
    await importing();const path=join(library,"editkin-color-luts.json"),data=JSON.parse(await readFile(path,"utf8"));
    // The existing cube parser bounds TITLE to120chars. A long cube TITLE does not fill metadata.
    // Model a valid already-near-quota manifest instead, then attempt one more distinct LUT.
    data.luts[0].title='a'.repeat(8*1024*1024-Buffer.byteLength(JSON.stringify(data,null,2))-100);
    const before=Buffer.from(JSON.stringify(data,null,2));await writeFile(path,before);await writeFile(source,'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n');
    await expect(importing()).rejects.toThrow(/8 MiB/);
    // Buffer.equals compares all bytes without Vitest enumerating millions of Buffer properties.
    expect((await readFile(path)).equals(before)).toBe(true);expect((await readdir(join(library,'luts'))).length).toBe(1);
    expect((await readdir(library)).some(n=>n.startsWith('.desktop-import-'))).toBe(false);
    expect((await call({operation:"list"}) as any).total).toBe(1);
  });
});
