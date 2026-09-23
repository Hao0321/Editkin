import {constants} from 'node:fs';
import {open,lstat,realpath,copyFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';

export const MATERIAL_COLOR_SIDECAR = 'mcp.mjs.material-color-identity.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
async function boundedFile(path,max){
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<=0||stat.size>max)throw Error('invalid-material-color-pair-file');
  const canonical=await realpath(path);
  const samePath=process.platform==='win32'?resolve(canonical).toLowerCase()===resolve(path).toLowerCase():resolve(canonical)===resolve(path);
  if(!samePath)throw Error('aliased-material-color-pair-file');
  const handle=await open(path,'r');
  try{
    const before=await handle.stat();if(before.size!==stat.size||before.ino!==stat.ino||before.dev!==stat.dev)throw Error('material-color-pair-read-drift');
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('material-color-pair-short-read');offset+=bytesRead;}
    const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('material-color-pair-read-drift');
    return bytes;
  }finally{await handle.close();}
}
/** Integrity pairing only, not signature/authenticity or execution acceptance. */
export async function verifyMaterialColorRuntimePair(bundlePath){
  const bytes=await boundedFile(bundlePath,64*1024*1024);
  const manifestBytes=await boundedFile(`${bundlePath}.material-color-identity.json`,65536);
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(!exact(manifest,['schema','bundle','implementations'])||manifest.schema!=='editkin.material-color-bundle/v1'||!exact(manifest.bundle,['file','size','sha256'])||manifest.bundle.file!==basename(bundlePath)||manifest.bundle.size!==bytes.length||manifest.bundle.sha256!==hash(bytes))throw Error('material-color-pair-identity-mismatch');
  if(!Array.isArray(manifest.implementations)||!manifest.implementations.length||manifest.implementations.length>33||new Set(manifest.implementations.map(x=>x?.name)).size!==manifest.implementations.length||manifest.implementations.some(x=>!exact(x,['name','sha256'])||typeof x.name!=='string'||!/^(?:\.\.\/)?(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:ts|json)$/.test(x.name)||typeof x.sha256!=='string'||!/^[a-f0-9]{64}$/.test(x.sha256)))throw Error('invalid-material-color-pair-implementations');
  return {bundleSha256:hash(bytes),sidecarSha256:hash(manifestBytes)};
}
/** Stages an immutable pair into an owned new directory, never repairs identities. */
export async function stageMaterialColorRuntimePair(sourceBundle,targetBundle){
  const before=await verifyMaterialColorRuntimePair(sourceBundle);
  await mkdir(dirname(targetBundle),{recursive:true});
  await copyFile(sourceBundle,targetBundle,constants.COPYFILE_EXCL);
  await copyFile(`${sourceBundle}.material-color-identity.json`,`${targetBundle}.material-color-identity.json`,constants.COPYFILE_EXCL);
  const staged=await verifyMaterialColorRuntimePair(targetBundle),after=await verifyMaterialColorRuntimePair(sourceBundle);
  if(JSON.stringify(before)!==JSON.stringify(staged)||JSON.stringify(before)!==JSON.stringify(after))throw Error('material-color-pair-copy-drift');
  return staged;
}
