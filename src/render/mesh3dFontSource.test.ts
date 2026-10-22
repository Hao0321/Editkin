import { describe,expect,it } from "vitest";
import { mkdtemp,readFile,writeFile,mkdir,copyFile,rm } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { readMesh3dFont } from "./mesh3dFontSource";
describe("bounded physical font source",()=>{
  it("reads licensed installed face bytes and fails closed after face tampering or an unlisted weight",async()=>{
    const real=resolve("public/fonts"),bytes=await readMesh3dFont(real,900);expect(bytes.length).toBeGreaterThan(1_000_000);await expect(readMesh3dFont(real,701)).rejects.toThrow("700／900");
    const root=await mkdtemp(join(tmpdir(),"editkin-mesh-font-test-"));
    try{
      await mkdir(join(root,"render"));await copyFile(join(real,"editkin-open-fonts.json"),join(root,"editkin-open-fonts.json"));
      await writeFile(join(root,"render/EditkinFace-noto-sans-tc-900.ttf"),Buffer.from("not a valid physical font"));
      await expect(readMesh3dFont(root,900)).rejects.toThrow("SHA 或大小");
      const manifest=JSON.parse(await readFile(join(root,"editkin-open-fonts.json"),"utf8"));manifest.fonts.find((f:any)=>f.family==="Noto Sans TC").faces.find((f:any)=>f.weight===900).file="../../outside.ttf";await writeFile(join(root,"editkin-open-fonts.json"),JSON.stringify(manifest));
      await expect(readMesh3dFont(root,900)).rejects.toThrow("manifest");
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
