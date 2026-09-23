import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,appendFile,copyFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {stageMaterialColorRuntimePair,verifyMaterialColorRuntimePair,MATERIAL_COLOR_SIDECAR} from './lib/material-color-runtime-pair.mjs';
import {createSnapshotManifest,validateSnapshotManifest,EDITKIN_RELEASE_RUNTIME_FILES,SNAPSHOT_TOP_LEVEL_DIRECTORIES} from './lib/editkin-mcp-generation-contract.mjs';
import {PRODUCT_REQUIRED_OUTPUT_PATHS} from './lib/build-input-identity.mjs';
import {buildMaterialColorBundle} from './lib/material-color-bundle-identity.mjs';
import {importVerifiedMaterialColorGeneration} from './lib/material-color-generation-bridge.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('current 33-name pair includes display transfer and stages unchanged',async()=>{
  const names=JSON.parse(await readFile('src/application/materialColorImplementationPaths.json','utf8'));
  assert.equal(names.length,33);assert.equal(names.filter(n=>n==='../color/displayTransfer.ts').length,1);
  const f=await fixture();f.manifest.implementations=names.map(name=>({name,sha256:'a'.repeat(64)}));
  await writeFile(`${f.bundle}.material-color-identity.json`,JSON.stringify(f.manifest));
  await stageMaterialColorRuntimePair(f.bundle,f.target);
  assert.deepEqual(await verifyMaterialColorRuntimePair(f.target),await verifyMaterialColorRuntimePair(f.bundle));
});
for(const mutation of ['34-inputs','33-duplicate','33-path-escape','33-absolute-path'])test(`current registry ${mutation} rejects before stage`,async()=>{
  const names=JSON.parse(await readFile('src/application/materialColorImplementationPaths.json','utf8'));
  assert.equal(names.length,33);const f=await fixture();f.manifest.implementations=names.map(name=>({name,sha256:'a'.repeat(64)}));
  if(mutation==='34-inputs')f.manifest.implementations.push({name:'extra.ts',sha256:'b'.repeat(64)});
  if(mutation==='33-duplicate')f.manifest.implementations[32]={...f.manifest.implementations[0]};
  if(mutation==='33-path-escape')f.manifest.implementations[25].name='../../color/displayTransfer.ts';
  if(mutation==='33-absolute-path')f.manifest.implementations[25].name='D:/color/displayTransfer.ts';
  await writeFile(`${f.bundle}.material-color-identity.json`,JSON.stringify(f.manifest));
  await assert.rejects(stageMaterialColorRuntimePair(f.bundle,f.target),/invalid-material-color-pair-implementations/);
  assert.equal((await readdir(f.root)).includes('stage'),false);
});
async function fixture(){await mkdir('.rd/tmp',{recursive:true});const root=await mkdtemp(resolve('.rd/tmp/sidecar-stage-'));const source=join(root,'source');await mkdir(source);const bundle=join(source,'mcp.mjs'),bytes=Buffer.from('export const ownedFixture = true;\n');await writeFile(bundle,bytes);const manifest={schema:'editkin.material-color-bundle/v1',bundle:{file:'mcp.mjs',size:bytes.length,sha256:sha(bytes)},implementations:[{name:'fixture.ts',sha256:'a'.repeat(64)}]};await writeFile(`${bundle}.material-color-identity.json`,JSON.stringify(manifest));return {root,bundle,manifest,target:join(root,'stage/mcp.mjs')};}
test('actual staging pair copies unchanged bounded bytes',async()=>{const f=await fixture();const identity=await stageMaterialColorRuntimePair(f.bundle,f.target);assert.deepEqual(identity,await verifyMaterialColorRuntimePair(f.bundle));assert.deepEqual((await readdir(join(f.root,'stage'))).sort(),['mcp.mjs',MATERIAL_COLOR_SIDECAR].sort());});
for(const mutation of ['missing','bundle-tamper','sidecar-hash','sidecar-size','sidecar-name','unknown-key','duplicate-input'])test(`${mutation} rejects before creating stage`,async()=>{const f=await fixture();if(mutation==='missing'){const {unlink}=await import('node:fs/promises');await unlink(`${f.bundle}.material-color-identity.json`);}else if(mutation==='bundle-tamper')await appendFile(f.bundle,'tamper');else{if(mutation==='sidecar-hash')f.manifest.bundle.sha256='b'.repeat(64);if(mutation==='sidecar-size')f.manifest.bundle.size++;if(mutation==='sidecar-name')f.manifest.bundle.file='../mcp.mjs';if(mutation==='unknown-key')f.manifest.extra=true;if(mutation==='duplicate-input')f.manifest.implementations.push(f.manifest.implementations[0]);await writeFile(`${f.bundle}.material-color-identity.json`,JSON.stringify(f.manifest));}await assert.rejects(stageMaterialColorRuntimePair(f.bundle,f.target));assert.equal((await readdir(f.root)).includes('stage'),false);});
test('unknown existing target bytes never overwritten',async()=>{const f=await fixture();await mkdir(join(f.root,'stage'));await writeFile(f.target,'do-not-replace');await assert.rejects(stageMaterialColorRuntimePair(f.bundle,f.target),{code:'EEXIST'});assert.equal(await readFile(f.target,'utf8'),'do-not-replace');});
test('tamper after copy rejected by actual verification',async()=>{const f=await fixture();await stageMaterialColorRuntimePair(f.bundle,f.target);await appendFile(f.target,'drift');await assert.rejects(verifyMaterialColorRuntimePair(f.target),/identity-mismatch/);});
test('all explicit current source inventories require the sidecar',async()=>{const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'));assert.equal(config.bundle.resources[`../desktop-dist/${MATERIAL_COLOR_SIDECAR}`],`runtime/${MATERIAL_COLOR_SIDECAR}`);assert.ok(PRODUCT_REQUIRED_OUTPUT_PATHS.includes(`desktop-dist/${MATERIAL_COLOR_SIDECAR}`));for(const path of ['scripts/stage-tauri-resources.mjs','scripts/lib/artifact-lifecycle.mjs','scripts/auto-roto-native-product-artifact-freshness-gate.ts','scripts/release-evidence.mjs'])assert.ok((await readFile(path,'utf8')).includes(MATERIAL_COLOR_SIDECAR),path);});
test('actual closed-world snapshot contract accepts paired inventory and rejects missing/unknown',()=>{const dirs=[...SNAPSHOT_TOP_LEVEL_DIRECTORIES,'color/aces2','creative-packs/hao-creator-library','font-packs/editkin-open-fonts','personal-packs/hao-music-library'].sort();const make=names=>createSnapshotManifest('candidate-0123456789abcdef',dirs,names.map(name=>({path:`runtime/${name}`,bytes:1,sha256:'a'.repeat(64)})).sort((a,b)=>a.path<b.path?-1:1));assert.ok(EDITKIN_RELEASE_RUNTIME_FILES.includes(MATERIAL_COLOR_SIDECAR));validateSnapshotManifest(make(EDITKIN_RELEASE_RUNTIME_FILES));assert.throws(()=>validateSnapshotManifest(make(EDITKIN_RELEASE_RUNTIME_FILES.filter(n=>n!==MATERIAL_COLOR_SIDECAR))),/closed-world/);assert.throws(()=>validateSnapshotManifest(make([...EDITKIN_RELEASE_RUNTIME_FILES,'unknown.json'])),/closed-world/);});
test('real source MCP bundle stages identically without executing it',async()=>{const f=await fixture(),original=join(f.root,'built/mcp.mjs');await buildMaterialColorBundle({entryPoints:['src/mcp/server.ts'],outfile:original});const before=sha(await readFile(original));const copied=join(f.root,'real/mcp.mjs');await stageMaterialColorRuntimePair(original,copied);assert.equal(sha(await readFile(copied)),before);assert.equal(sha(await readFile(original)),before);console.log(JSON.stringify({kind:'REAL_SOURCE_BUNDLE_COPY_NOT_INSTALLER',source:original,staged:copied,identity:await verifyMaterialColorRuntimePair(copied)}));});
test('identical bundle bytes in different generation paths do not share captured module context',async()=>{
  const f=await fixture(),a=join(f.root,'A/mcp.mjs'),b=join(f.root,'B/mcp.mjs');
  await buildMaterialColorBundle({entryPoints:['src/application/materialColorCodeIdentity.ts'],outfile:a});await stageMaterialColorRuntimePair(a,b);
  async function load(file){const pair=await verifyMaterialColorRuntimePair(file);return importVerifiedMaterialColorGeneration({entrypoint:file,entrypointBytes:await readFile(file),manifest:{entrypoint:'runtime/mcp.mjs',files:[{path:'runtime/mcp.mjs.material-color-identity.json',sha256:pair.sidecarSha256}]}},url=>import(url));}
  const A=await load(a),B=await load(b);assert.notEqual(A,B);assert.equal(await load(b),B,'same exact generation intentionally reuses its own module');
  const expected=B.materialColorCodeIdentity();await rename(join(f.root,'A'),join(f.root,'A-moved'));
  assert.deepEqual(B.materialColorCodeIdentity(),expected);assert.throws(()=>A.materialColorCodeIdentity(),/ENOENT/);
  // Pair transport permits a bounded subset; the actual executing consumer must
  // additionally reject missing/renamed/reordered helpers against embedded names.
  const sidecar=`${b}.material-color-identity.json`,original=JSON.parse(await readFile(sidecar,'utf8'));
  assert.equal(original.implementations.length,33);
  for(const mutation of ['missing-display-helper','wrong-valid-name','reordered']){
    const changed=structuredClone(original),at=changed.implementations.findIndex(row=>row.name==='../color/displayTransfer.ts');assert.notEqual(at,-1);
    if(mutation==='missing-display-helper')changed.implementations.splice(at,1);
    if(mutation==='wrong-valid-name')changed.implementations[at].name='../color/notDisplayTransfer.ts';
    if(mutation==='reordered')[changed.implementations[0],changed.implementations[1]]=[changed.implementations[1],changed.implementations[0]];
    await writeFile(sidecar,JSON.stringify(changed));
    await verifyMaterialColorRuntimePair(b); // structurally valid transport alone is not authority
    assert.throws(()=>B.materialColorCodeIdentity(),/data-bundle-sidecar-drift/,`${mutation}: already-loaded generation`);
    const reloaded=await load(b);
    assert.throws(()=>reloaded.materialColorCodeIdentity(),/invalid-code-implementation-list/,`${mutation}: fresh generation validates names`);
  }
});
