import {lstat,realpath} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildMaterialColorBundle} from './material-color-bundle-identity.mjs';
import {readRegularFile} from './regular-file.mjs';
const defaultRoot=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const externalData=new Set(['../../community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json','../../community/hao-motion-kit/OWNER_VISUAL_GRANT.json','video-autopilot-skill-integration.json']);
async function inputs(root){
 const registry=resolve(root,'src/application/shotGradeImplementationPathsV1.json'),s=await lstat(registry);
 if(!s.isFile()||s.isSymbolicLink()||s.size>65536)throw Error('shot-grade-build-registry-invalid');
 const names=JSON.parse((await readRegularFile(registry)).toString('utf8'));
 if(!Array.isArray(names)||names.length<3||names.length>512||new Set(names).size!==names.length
  ||!['src/application/shotGradeImplementationPathsV1.json','src/application/shotGradeCodeIdentityV1.ts','src/color/shotGradeCandidateV1.ts'].every(n=>names.includes(n)))throw Error('shot-grade-build-registry-invalid');
 return Promise.all(names.map(async name=>{
  if(typeof name!=='string'||name.includes('\\')||isAbsolute(name)||(!/^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|mjs|json)$/.test(name)&&!externalData.has(name)))throw Error('shot-grade-build-path-invalid');
  const path=resolve(root,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024||(await realpath(path)).toLowerCase()!==path.toLowerCase())throw Error('shot-grade-build-alias-or-size-invalid');
  return {name,sha256:sha(await readRegularFile(path))};
 }));
}
/** One actual ESM byte unit carries both manifests. The unchanged primary
 * sidecar verifies those executed bytes; new grade inputs are embedded in it.
 * Does not stage, install, activate or sign a generation. */
export async function buildShotGradeBundleV1(options){
 const root=resolve(options.absWorkingDir??defaultRoot),before=await inputs(root);
 if(Object.hasOwn(options.define??{},'__EDITKIN_SHOT_GRADE_BUILD_V1__'))throw Error('shot-grade-identity-define-reserved');
 const verifier={name:'editkin-shot-grade-input-integrity-v1',setup(build){build.onEnd(async()=>{
  if(JSON.stringify(before)!==JSON.stringify(await inputs(root)))throw Error('shot-grade-build-input-drift');
 });}};
 const result=await buildMaterialColorBundle({...options,absWorkingDir:root,
  define:{...options.define,__EDITKIN_SHOT_GRADE_BUILD_V1__:JSON.stringify({schema:'editkin.shot-grade-build/v1',implementations:before})},
  plugins:[...(options.plugins??[]),verifier]});
 return {...result,shotGradeImplementations:before};
}
