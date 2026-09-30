import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute,join,relative } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";

/** Fixed bundled faces only. No arbitrary filename, URL, network source or CSP change. */
export async function readMesh3dFont(root:string,weight:number):Promise<Uint8Array>{
  if(!isAbsolute(root)||(weight!==700&&weight!==900))throw new Error("3D 字型只接受內建 Noto Sans TC 700／900");
  const filename=`render/EditkinFace-noto-sans-tc-${weight}.ttf`,canonicalRoot=await realpath(root),target=join(root,filename),canonicalTarget=await realpath(target),child=relative(canonicalRoot,canonicalTarget);
  if(child.startsWith("..")||isAbsolute(child))throw new Error("3D 字型不可指向字型目錄之外");
  const manifest=JSON.parse((await readBoundedFile(join(root,"editkin-open-fonts.json"),1024*1024)).toString("utf8"));
  const face=manifest.fonts?.find((font:{family:string})=>font.family==="Noto Sans TC")?.faces?.find((face:{weight:number})=>face.weight===weight);
  if(manifest.schemaVersion!==2||face?.file!==filename||!/^[a-f0-9]{64}$/.test(face?.sha256??""))throw new Error("3D 物理字型 manifest 不合法");
  const bytes=await readBoundedFile(target,16*1024*1024);
  if(!bytes.length||bytes.length!==face.bytes||createHash("sha256").update(bytes).digest("hex")!==face.sha256)throw new Error("3D 物理字型 SHA 或大小不符");
  return new Uint8Array(bytes);
}
