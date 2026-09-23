import { mkdtemp, mkdir, writeFile, readFile, unlink, symlink, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { creativeAssetIdFromUri, creativeAssetUri, listCreativeLibrary, resolveCreativeLibraryAsset, resolveCreativeLibraryPreviewAsset, materializeCreativeAssets } from "./creativeLibrary";
import { createDemoProject } from "../domain/demo";
import { selectAutomaticMusicAsset } from "../creative/musicSelection";
import { OWNER_VISUAL_GRANT, OWNER_VISUAL_LICENSE } from "../shared/visualAssetRights.mjs";

async function fixture(privateWorkspaceEmbedded = false) {
  const root = await mkdtemp(join(tmpdir(), "editkin-pack-test-"));
  await mkdir(join(root, "assets"));
  const bytes = Buffer.from("portable-asset");
  await writeFile(join(root, "assets", "sample.mp4"), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "editkin-pack.json"), JSON.stringify({
    schemaVersion: 1, id: "test.pack", name: "Test", version: "1.0.0", attribution: "Test",
    source: { privateImagesEmbedded: false }, assetCount: 1, assetBytes: bytes.length,
    portability: { relativePathsOnly: true, privateWorkspaceEmbedded, originalPrivateReferencesEmbedded: false },
    assets: [{ id: "sample", name: "Sample", category: "broll", role: "broll", domains: ["test"], mediaKind: "video", path: "assets/sample.mp4", bytes: bytes.length, sha256, license: "CC-BY-4.0", provenance: "fixture", renderer: "media-asset" }],
  }));
  return root;
}

describe("portable Creative Library", () => {
  it("projects only the eight known procedural backgrounds consistently, without altering originals", async()=>{
    const root=await fixture(),path=join(root,"editkin-pack.json");
    const manifest=JSON.parse(await readFile(path,"utf8"));
    const original=manifest.assets[0],ids=["broll:0d152ac1677e","broll:0e20a6a51040","broll:20b4715a9638","broll:217399fe9b38","broll:2f3e5e265fda","broll:724f1b44869d","broll:95edd98fb3a4","broll:faa0906d5230"];
    for(const id of ids){
      manifest.assets=[{...original,id,provenance:"domain_broll_pack.py procedural original"}];
      await writeFile(path,JSON.stringify(manifest));const before=await readFile(path,"utf8");
      const listed=(await listCreativeLibrary(root)).assets[0],resolved=await resolveCreativeLibraryAsset(root,id);
      expect(listed).toMatchObject({id,category:"motion",role:"motion-background",license:original.license});expect(resolved.asset).toEqual(listed);
      expect(resolved.sha256).toBe(original.sha256);expect(await readFile(path,"utf8")).toBe(before);
    }
    for(const asset of [{...original,id:ids[0],provenance:"licensed real camera footage"},{...original,id:"other-broll",provenance:"domain_broll_pack.py procedural original"}]){
      manifest.assets=[asset];await writeFile(path,JSON.stringify(manifest));expect((await listCreativeLibrary(root)).assets[0].category).toBe("broll");
    }
  });
  it("lists metadata without leaking filesystem paths and verifies the selected file", async () => {
    const root = await fixture();
    const listed = await listCreativeLibrary(root);
    expect(listed.assets[0]).not.toHaveProperty("path");
    expect(listed.assets[0]).not.toHaveProperty("sha256");
    const resolved = await resolveCreativeLibraryAsset(root, "sample");
    expect(resolved.sha256).toHaveLength(64);
    expect(resolved.absolutePath).toContain(root);
  });

  it("fails closed when a pack claims embedded private workspace content", async () => {
    await expect(listCreativeLibrary(await fixture(true))).rejects.toThrow(/私人來源/);
  });

  it("rejects a matching-byte public original behind a directory junction outside the pack", async () => {
    const root=await fixture(),outside=await mkdtemp(join(tmpdir(),"editkin-outside-original-"));
    const manifest=JSON.parse(await readFile(join(root,"editkin-pack.json"),"utf8"));
    await writeFile(join(outside,"sample.mp4"),"portable-asset");
    await symlink(outside,join(root,"escaped"),process.platform==="win32"?"junction":"dir");
    manifest.assets[0].path="escaped/sample.mp4";
    await writeFile(join(root,"editkin-pack.json"),JSON.stringify(manifest));
    await expect(resolveCreativeLibraryAsset(root,"sample")).rejects.toThrow(/離開 root/);
  });

  it("uses a portable URI instead of an installation-specific absolute path", () => {
    const uri = creativeAssetUri("motion:hero-title");
    expect(uri).toBe("creative://studio.hao.creator-library/motion%3Ahero-title");
    expect(creativeAssetIdFromUri(uri)).toBe("motion:hero-title");
  });

  it("selects project-fit music deterministically and penalizes recent reuse", () => {
    const assets = [
      { id: "music:food", name: "料理節奏", category: "美食", role: "background-music", domains: ["美食"], mediaKind: "audio" as const, bytes: 1, license: "HAO-COMMUNITY-ASSET-GRANT-1.0", provenance: "fixture", duration: 150, bpm: 106, suggestedUse: "general/explain" },
      { id: "music:hike", name: "森林散步", category: "登山健行", role: "background-music", domains: ["森林"], mediaKind: "audio" as const, bytes: 1, license: "HAO-COMMUNITY-ASSET-GRANT-1.0", provenance: "fixture", duration: 150, bpm: 95, suggestedUse: "general/explain" },
    ];
    expect(selectAutomaticMusicAsset(assets, { projectName: "台北美食", duration: 120 })?.id).toBe("music:food");
    expect(selectAutomaticMusicAsset(assets, { projectName: "台北美食", duration: 120, recentAssetIds: ["music:food"] })?.id).toBe("music:hike");
  });

  it("keeps the community redistribution grant on selected music metadata", () => {
    const assets = [
      { id: "music:community", name: "社群配樂", category: "教學", role: "background-music", domains: ["教學"], mediaKind: "audio" as const, bytes: 1, license: "HAO-COMMUNITY-ASSET-GRANT-1.0", provenance: "owner-attested-ai-generated", duration: 120, bpm: 110, suggestedUse: "general/explain", redistributable: true },
    ];
    const selected = selectAutomaticMusicAsset(assets, { projectName: "教學", duration: 60 });
    expect(selected).toMatchObject({ license: "HAO-COMMUNITY-ASSET-GRANT-1.0", redistributable: true });
  });
});

// Real closed-world attestation; media sentinels below are transport-only fixtures,
// not decode/visual evidence. Original resolution uses an approved actual source.
async function ownerGrantFixture() {
  const root=await fixture(),manifest=JSON.parse(await readFile(join(root,"editkin-pack.json"),"utf8"));
  const grant=structuredClone(OWNER_VISUAL_GRANT);
  await mkdir(join(root,"licenses"));
  await copyFile(new URL('../../../../community/hao-motion-kit/OWNER_VISUAL_BUNDLE_GRANT.md',import.meta.url),join(root,grant.document.path));
  const bytes=Buffer.from('preview transport fixture only'),file={path:'poster.jpg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(join(root,file.path),bytes);await writeFile(join(root,'preview.mp4'),bytes);
  const assets=grant.assets.map(row=>({...row,path:row.sourcePath,license:OWNER_VISUAL_LICENSE,rightsBasis:grant.id,distributionScope:'bundled-redistributable',redistributable:true,renderer:'media-asset',derivatives:{sourceSha256:row.sha256,revision:'c'.repeat(64),poster:file,media:{...file,path:'preview.mp4'}}}));
  manifest.ownerVisualGrant=grant;manifest.assets.push(...assets);manifest.assetCount=manifest.assets.length;manifest.assetBytes=manifest.assets.reduce((n:number,a:{bytes:number})=>n+a.bytes,0);
  const save=()=>writeFile(join(root,'editkin-pack.json'),JSON.stringify(manifest));await save();
  return {root,manifest,grant,assets,save};
}

describe('owner-attested public visual aliases',()=>{
  it('resolves all 63 legacy poster/media aliases without a private root and exposes bounded rights',async()=>{
    const f=await ownerGrantFixture(),listed=await listCreativeLibrary(f.root);
    expect(listed.assetCount).toBe(64);expect(listed.restrictedAssetCount).toBe(0);
    expect(listed.assets.slice(0,63).map(a=>a.id)).toEqual(f.assets.map(a=>a.id));expect(listed.assets[63].id).toBe('sample');
    for(const alias of f.grant.legacyAliases){
      const asset=listed.assets.find(a=>a.id===alias.assetId)!;
      expect(asset).toMatchObject({rightsBasis:f.grant.id,redistributable:true,distributionScope:'bundled-redistributable'});
      for(const mode of ['poster','media'] as const)expect((await resolveCreativeLibraryPreviewAsset(f.root,alias.legacyId,mode)).asset.id).toBe(alias.assetId);
    }
    for(const id of ['private-visual:c0ed2a1b16f73e180008','private-visual:6a76d07ac0fa25326c4f','private-visual:'+'f'.repeat(20)]){
      await expect(resolveCreativeLibraryAsset(f.root,id)).rejects.toThrow(/未安裝/);
      await expect(resolveCreativeLibraryPreviewAsset(f.root,id,'poster')).rejects.toThrow(/未安裝/);
    }
  },15_000);
  it('materializes one true original through old URI without rewriting the stored project or choosing a proxy',async()=>{
    const f=await ownerGrantFixture(),row=f.assets[0],alias=f.grant.legacyAliases.find(a=>a.assetId===row.id)!;
    const target=join(f.root,row.path);await mkdir(join(target,'..'),{recursive:true});
    await copyFile(new URL('../../../../community/hao-motion-kit/'+row.sourcePath,import.meta.url),target);
    const resolved=await resolveCreativeLibraryAsset(f.root,alias.legacyId);expect(resolved.sha256).toBe(alias.sha256);expect(resolved.absolutePath).toBe(target);
    const project=createDemoProject();project.assets[0].uri=creativeAssetUri(alias.legacyId);const before=JSON.stringify(project);
    expect((await materializeCreativeAssets(project,f.root)).assets[0].uri).toBe(target);expect(JSON.stringify(project)).toBe(before);
    await writeFile(target,'tampered source');await expect(resolveCreativeLibraryAsset(f.root,alias.legacyId)).rejects.toThrow(/完整性/);
  });
  it('deduplicates old owner65 only by exact alias+hash+bytes and retains unrelated private rows',async()=>{
    const f=await ownerGrantFixture(),v=await visualFixture();
    const old=f.assets.map(row=>({...v.asset,...row,domains:[...row.domains],id:f.grant.legacyAliases.find(a=>a.assetId===row.id)!.legacyId,license:'PRIVATE-OWNER-ONLY',rightsBasis:'private-owner-only',redistributable:false,width:1920,height:1080,duration:6}));
    // Remove public-only metadata from the legacy fixture; it is not relicensed in place.
    for(const row of old)delete (row as {distributionScope?:string}).distributionScope;
    v.manifest.assets.push(...old as typeof v.manifest.assets);v.manifest.assetCount=v.manifest.assets.length;v.manifest.assetBytes=v.manifest.assets.reduce((n,a)=>n+a.bytes,0);await v.save();
    const listed=await listCreativeLibrary(f.root,undefined,v.root);expect(listed.assetCount).toBe(65);expect(listed.restrictedAssetCount).toBe(1);expect(listed.assetBytes).toBe(f.manifest.assetBytes+v.asset.bytes);expect(listed.assets[0].id).toBe(v.asset.id);expect(listed.assets.slice(1,64).map(a=>a.id)).toEqual(f.assets.map(a=>a.id));
    old[0].sha256='e'.repeat(64);old[0].derivatives.sourceSha256=old[0].sha256;await v.save();
    await expect(listCreativeLibrary(f.root,undefined,v.root)).rejects.toThrow(/衝突/);
  });
  it('rejects grant mapping/document/member and preview binding tamper, without private fallback',async()=>{
    for(const mutate of [
      (f:Awaited<ReturnType<typeof ownerGrantFixture>>)=>{f.manifest.ownerVisualGrant.legacyAliases[0].assetId=f.assets[1].id;},
      (f:Awaited<ReturnType<typeof ownerGrantFixture>>)=>{f.manifest.assets.pop();f.manifest.assetCount--;},
      (f:Awaited<ReturnType<typeof ownerGrantFixture>>)=>{f.manifest.assets[1].derivatives.sourceSha256='e'.repeat(64);},
      (f:Awaited<ReturnType<typeof ownerGrantFixture>>)=>{f.manifest.ownerVisualGrant.document.sha256='e'.repeat(64);},
    ]){const f=await ownerGrantFixture();mutate(f);await f.save();await expect(listCreativeLibrary(f.root)).rejects.toThrow();}
    const f=await ownerGrantFixture();await writeFile(join(f.root,f.grant.document.path),'wrong grant');await expect(listCreativeLibrary(f.root)).rejects.toThrow();
    const g=await ownerGrantFixture();await writeFile(join(g.root,'preview.mp4'),'wrong preview');await expect(resolveCreativeLibraryPreviewAsset(g.root,g.grant.legacyAliases[0].legacyId,'media')).rejects.toThrow(/完整性/);
  });
});

async function visualFixture() {
  const root=await mkdtemp(join(tmpdir(),"editkin-private-visual-"));
  const file=async(path:string,text:string)=>{const bytes=Buffer.from(text);await writeFile(join(root,path),bytes);return {path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};};
  const original=await file("original.mov","ORIGINAL FULL SOURCE"),poster=await file("poster.jpg","POSTER"),media=await file("preview.mp4","PROXY");
  const asset={id:"private-visual:"+"a".repeat(20),name:"Private",category:"private_animation",role:"private-animation",domains:["general"],mediaKind:"video",...original,width:1920,height:1080,duration:6,license:"PRIVATE-OWNER-ONLY",rightsBasis:"private-owner-only",redistributable:false,provenance:"owner import",renderer:"media-asset",derivatives:{sourceSha256:original.sha256,revision:"b".repeat(64),poster,media}};
  const manifest={schemaVersion:1,id:"studio.hao.personal-visual-library",distributionScope:"private-owner-only",redistributable:false,assetCount:1,assetBytes:original.bytes,assets:[asset]};
  const save=()=>writeFile(join(root,"editkin-personal-visual.json"),JSON.stringify(manifest));await save();
  return {root,asset,manifest,save};
}
describe("owner-only visual library",()=>{
  it("supports source-bound public derivatives without changing original import",async()=>{
    const root=await fixture(),path=join(root,"editkin-pack.json"),manifest=JSON.parse(await readFile(path,"utf8"));
    const bytes=Buffer.from("PUBLIC POSTER");await writeFile(join(root,"poster.jpg"),bytes);
    manifest.assets[0].derivatives={sourceSha256:manifest.assets[0].sha256,revision:"c".repeat(64),poster:{path:"poster.jpg",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}};
    await writeFile(path,JSON.stringify(manifest));
    expect((await listCreativeLibrary(root)).assets[0].preview?.poster).toBe(true);
    expect((await resolveCreativeLibraryPreviewAsset(root,"sample","poster")).absolutePath).toBe(join(root,"poster.jpg"));
    expect((await resolveCreativeLibraryAsset(root,"sample")).absolutePath).toBe(join(root,"assets","sample.mp4"));
    manifest.assets[0].derivatives.sourceSha256="f".repeat(64);await writeFile(path,JSON.stringify(manifest));
    await expect(listCreativeLibrary(root)).rejects.toThrow(/binding/);
  });
  it("lists without opening originals, keeps rights, resolves proxy versus original and materializes original only",async()=>{
    const pack=await fixture(),v=await visualFixture();
    const listed=await listCreativeLibrary(pack,undefined,v.root);
    expect(listed.restrictedAssetCount).toBe(1);expect(listed.assets[0]).toMatchObject({id:v.asset.id,redistributable:false,rightsBasis:"private-owner-only",preview:{poster:true,motion:true}});
    expect(listed.assets[0]).not.toHaveProperty("path");
    expect(listed.assets[1].id).toBe("sample");expect((await listCreativeLibrary(pack)).assets.map(a=>a.id)).toEqual(["sample"]);
    expect((await resolveCreativeLibraryPreviewAsset(pack,v.asset.id,"poster",undefined,v.root)).sha256).toBe(v.asset.derivatives.poster.sha256);
    expect((await resolveCreativeLibraryPreviewAsset(pack,v.asset.id,"media",undefined,v.root)).sha256).toBe(v.asset.derivatives.media.sha256);
    const original=await resolveCreativeLibraryAsset(pack,v.asset.id,undefined,v.root);
    expect(await readFile(original.absolutePath,"utf8")).toBe("ORIGINAL FULL SOURCE");
    const p=createDemoProject();p.assets[0].uri=creativeAssetUri(v.asset.id);
    const resolved=await materializeCreativeAssets(p,pack,undefined,v.root);
    expect(resolved.assets[0].uri).toBe(original.absolutePath);expect(p.assets[0].uri).toMatch(/^creative:/);
    await unlink(original.absolutePath);
    expect((await listCreativeLibrary(pack,undefined,v.root)).assetCount).toBe(2);
    await expect(resolveCreativeLibraryAsset(pack,v.asset.id,undefined,v.root)).rejects.toThrow();
  });
  it("rejects private promotion, unsafe paths, duplicate ids and detached preview source binding",async()=>{
    const pack=await fixture();
    for(const mutate of [(v:Awaited<ReturnType<typeof visualFixture>>)=>{v.manifest.redistributable=true;},(v:Awaited<ReturnType<typeof visualFixture>>)=>{v.asset.path="../escape.mov";},(v:Awaited<ReturnType<typeof visualFixture>>)=>{v.asset.derivatives.sourceSha256="0".repeat(64);},(v:Awaited<ReturnType<typeof visualFixture>>)=>{v.manifest.assets.push(v.asset);v.manifest.assetCount=2;}]){
      const v=await visualFixture();mutate(v);await v.save();await expect(listCreativeLibrary(pack,undefined,v.root)).rejects.toThrow();
    }
  });
  it("rejects tampered poster/proxy bytes, missing root and refuses fictional public posters",async()=>{
    const pack=await fixture(),v=await visualFixture();await writeFile(join(v.root,"poster.jpg"),"SWAPXX");
    await expect(resolveCreativeLibraryPreviewAsset(pack,v.asset.id,"poster",undefined,v.root)).rejects.toThrow(/完整性/);
    await writeFile(join(v.root,"preview.mp4"),"WRONG");
    await expect(resolveCreativeLibraryPreviewAsset(pack,v.asset.id,"media",undefined,v.root)).rejects.toThrow(/完整性/);
    await expect(resolveCreativeLibraryAsset(pack,v.asset.id)).rejects.toThrow(/未安裝/);
    await expect(resolveCreativeLibraryPreviewAsset(pack,"sample","poster")).rejects.toThrow(/poster/);
  });
});
