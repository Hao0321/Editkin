import {readFileSync,lstatSync,realpathSync} from "node:fs";
import {resolve,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {materialColorCodeIdentity} from "./materialColorCodeIdentity";
import {canonicalJson} from "../shared/canonicalJson";
import implementationPaths from "./shotGradeImplementationPathsV1.json";

declare const __EDITKIN_SHOT_GRADE_BUILD_V1__:unknown;
const embedded:unknown=typeof __EDITKIN_SHOT_GRADE_BUILD_V1__==="undefined"?undefined:__EDITKIN_SHOT_GRADE_BUILD_V1__;
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const digest=(value:unknown)=>sha(Buffer.from(canonicalJson(value)));
const externalData=new Set(["../../community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json","../../community/hao-motion-kit/OWNER_VISUAL_GRANT.json","video-autopilot-skill-integration.json"]);
const sourceModule=import.meta.url.endsWith("/shotGradeCodeIdentityV1.ts");
const root=sourceModule?fileURLToPath(new URL("../../",import.meta.url)):undefined;
function sourceInputs(){
 if(!root||!Array.isArray(implementationPaths)||implementationPaths.length<3||implementationPaths.length>512||new Set(implementationPaths).size!==implementationPaths.length)throw Error("shot-grade-source-registry-invalid");
 return implementationPaths.map(name=>{
  if(typeof name!=="string"||name.includes("\\")||isAbsolute(name)||(!/^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|mjs|json)$/.test(name)&&!externalData.has(name)))throw Error("shot-grade-source-path-invalid");
  const path=resolve(root,name),s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024||realpathSync(path).toLowerCase()!==path.toLowerCase())throw Error("shot-grade-source-alias-or-size-invalid");
  const bytes=readFileSync(path);if(bytes.length!==s.size)throw Error("shot-grade-source-size-drift");
  return {name,sha256:sha(bytes)};
 });
}
// New grade inputs have their own registry. The existing 33-input primary
// registry and its actual loaded executable-byte binder remain unchanged.
const loadedSource=(()=>{if(embedded!==undefined)return undefined;try{return sourceInputs();}catch{return undefined;}})();
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join("|")===keys.sort().join("|");
export interface ShotGradeCodeIdentityV1 {
 schema:"editkin.shot-grade-code-identity/v1";identitySha256:string;
 code:NonNullable<ReturnType<typeof materialColorCodeIdentity>["code"]>;
 primaryImplementations:ReturnType<typeof materialColorCodeIdentity>["implementations"];
 implementations:Array<{name:string;sha256:string}>;
 dependencyScope:"explicit-owned-runtime-source-closure-and-primary-code-unit";
}
export function shotGradeCodeIdentityV1():ShotGradeCodeIdentityV1 {
 const primary=materialColorCodeIdentity();if(!primary.code)throw Error("shot-grade-loaded-code-unit-required");
 let implementations:Array<{name:string;sha256:string}>;
 if(embedded===undefined){
  if(!sourceModule||!loadedSource)throw Error("shot-grade-instrumented-bundle-required");
  implementations=sourceInputs();if(canonicalJson(implementations)!==canonicalJson(loadedSource))throw Error("shot-grade-loaded-source-drift");
 }else{
  if(primary.code.mode!=="bundle"||!exact(embedded,["schema","implementations"])||embedded.schema!=="editkin.shot-grade-build/v1"
   ||!Array.isArray(embedded.implementations)||embedded.implementations.length!==implementationPaths.length)throw Error("shot-grade-embedded-identity-invalid");
  implementations=embedded.implementations.map((item,index)=>{
   if(!exact(item,["name","sha256"])||item.name!==implementationPaths[index]||typeof item.sha256!=="string"||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error("shot-grade-embedded-input-invalid");
   return {name:item.name as string,sha256:item.sha256};
  });
 }
 const value={schema:"editkin.shot-grade-code-identity/v1" as const,code:primary.code,primaryImplementations:primary.implementations,
  implementations,dependencyScope:"explicit-owned-runtime-source-closure-and-primary-code-unit" as const};
 return {...value,identitySha256:digest(value)};
}
