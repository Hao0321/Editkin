import { readFileSync,lstatSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import implementationPaths from "./materialColorImplementationPaths.json";
import type { MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";

declare const __EDITKIN_MATERIAL_COLOR_BUILD__: unknown;
const embedded:unknown=typeof __EDITKIN_MATERIAL_COLOR_BUILD__==="undefined"?undefined:__EDITKIN_MATERIAL_COLOR_BUILD__;
const dataModule=import.meta.url.startsWith('data:text/javascript;base64,');
const dataContext:unknown=dataModule?(globalThis as Record<symbol,unknown>)[Symbol.for('editkin.material-color.verified-data-bundle/v1')]:undefined;
const context=(()=>{
  if(!dataModule)return undefined;
  if(!dataContext||typeof dataContext!=='object'||Array.isArray(dataContext))throw Error('verified-data-bundle-context-required');
  const value=dataContext as Record<string,unknown>;
  if(Object.keys(value).sort().join('|')!=='bundleSha256|entrypoint|schema|sidecarSha256'||value.schema!=='editkin.material-color-data-context/v1'||typeof value.entrypoint!=='string'||typeof value.bundleSha256!=='string'||typeof value.sidecarSha256!=='string'||!(/^[a-f0-9]{64}$/).test(value.bundleSha256)||!(/^[a-f0-9]{64}$/).test(value.sidecarSha256))throw Error('invalid-data-bundle-context');
  const dataBytes=Buffer.from(import.meta.url.split('#',1)[0]!.slice('data:text/javascript;base64,'.length),'base64');
  if(createHash('sha256').update(dataBytes).digest('hex')!==value.bundleSha256)throw Error('executed-data-bundle-identity-mismatch');
  return Object.freeze({entrypoint:value.entrypoint,bundleSha256:value.bundleSha256,sidecarSha256:value.sidecarSha256});
})();
const modulePath=context?.entrypoint??fileURLToPath(import.meta.url);
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function bytes(path:string,maximum:number):Buffer {
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum)throw Error("invalid-code-identity-file");
  const value=readFileSync(path);if(value.length!==stat.size)throw Error("code-identity-file-drift");return value;
}
// Capture the running module at initialization, then compare on every identity
// request. A later rewritten bundle cannot be represented as the loaded code.
const loaded=(()=>{try{const value=sha(bytes(modulePath,64*1024*1024));if(context&&value!==context.bundleSha256)throw Error('executed-data-bundle-live-drift');return value;}catch{return undefined;}})();
const readSource=()=>implementationPaths.map(name=>({name,sha256:sha(bytes(fileURLToPath(new URL(name,import.meta.url)),8*1024*1024))}));
const loadedSource=(()=>{try{return embedded===undefined&&basename(modulePath)==="materialColorCodeIdentity.ts"?readSource():undefined;}catch{return undefined;}})();
const fields=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join("|")===keys.sort().join("|");
function implementations(value:unknown):Array<{name:string;sha256:string}> {
  if(!Array.isArray(value)||value.length!==implementationPaths.length)throw Error("invalid-code-implementation-list");
  return value.map((item,index)=>{if(!fields(item,["name","sha256"])||item.name!==implementationPaths[index]||typeof item.sha256!=="string"||!(/^[a-f0-9]{64}$/).test(item.sha256))throw Error("invalid-code-implementation-list");return {name:item.name as string,sha256:item.sha256};});
}
export function materialColorCodeIdentity():Pick<MaterialColorRuntimeIdentity,"implementations"|"code"> {
  const current=bytes(modulePath,64*1024*1024),digest=sha(current);
  if(!loaded||digest!==loaded)throw Error("loaded-code-bytes-drift");
  if(embedded===undefined){
    // Exact source entry only. An uninstrumented .mjs/.js bundle never falls
    // back to adjacent source files, even when a source tree happens to exist.
    if(basename(modulePath)!=="materialColorCodeIdentity.ts")throw Error("bundle-identity-manifest-required");
    const currentSource=readSource();
    if(!loadedSource||JSON.stringify(currentSource)!==JSON.stringify(loadedSource))throw Error("loaded-source-tree-drift");
    return {implementations:currentSource,code:{mode:"source",entry:"materialColorCodeIdentity.ts",sha256:digest,size:current.length}};
  }
  if(!fields(embedded,["schema","implementations"])||embedded.schema!=="editkin.material-color-build/v1")throw Error("invalid-embedded-code-identity");
  const expected=implementations(embedded.implementations);
  const manifestBytes=bytes(`${modulePath}.material-color-identity.json`,65536);
  if(context&&sha(manifestBytes)!==context.sidecarSha256)throw Error('data-bundle-sidecar-drift');
  const manifest:unknown=JSON.parse(manifestBytes.toString("utf8"));
  if(!fields(manifest,["schema","bundle","implementations"])||manifest.schema!=="editkin.material-color-bundle/v1"||!fields(manifest.bundle,["file","size","sha256"]))throw Error("invalid-bundle-identity-manifest");
  if(manifest.bundle.file!==basename(modulePath)||manifest.bundle.size!==current.length||manifest.bundle.sha256!==digest)throw Error("bundle-bytes-identity-mismatch");
  if(JSON.stringify(implementations(manifest.implementations))!==JSON.stringify(expected))throw Error("embedded-build-input-mismatch");
  return {implementations:expected,code:{mode:"bundle",entry:basename(modulePath),sha256:digest,size:current.length,manifestSha256:sha(manifestBytes)}};
}
