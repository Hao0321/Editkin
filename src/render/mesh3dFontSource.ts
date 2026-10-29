import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute,join,relative } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { readBundledFontFace } from "./bundledFontSource";

/**
 * Any bundled face by its compiled catalog ID (text_extrude / band_text). The ID is resolved against the compiled
 * catalog before any filesystem I/O; readBundledFontFace then pins the manifest SHA and the face's size and SHA-256.
 */
export async function readMesh3dFaceV1(root:string,faceId:string):Promise<{bytes:Uint8Array;faceId:string;file:string;sha256:string}>{
  const spec=bundledFontFaceSpec(faceId);
  const bytes=await readBundledFontFace(root,spec.faceId);
  if(createHash("sha256").update(bytes).digest("hex")!==spec.sha256)throw new Error("3D 字型 SHA 與內建字型目錄不符");
  return {bytes,faceId:spec.faceId,file:spec.fontFile,sha256:spec.sha256};
}

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
