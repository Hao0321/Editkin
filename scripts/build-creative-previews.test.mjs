import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {populateCreativePreviews} from './lib/creative-preview-producer.mjs';
import {copyPublicAuxiliary} from './build-creative-previews.mjs';
import {digest,run} from './build-personal-visual-pack.mjs';
test('real producer cold/warm, stale recipe and corrupted cache; originals and license stay unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'creative-producer-')),ffmpeg=resolve('vendor/ffmpeg/win32-x64/ffmpeg.exe'),ffprobe=resolve('vendor/ffmpeg/win32-x64/ffprobe.exe');
 const video=join(root,'fixture.mp4');await run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','1','-c:v','libx264','-pix_fmt','yuv420p',video]);
 const bytes=(await readFile(video)).length,sha256=await digest(video);
 const base={schemaVersion:1,assetCount:1,assets:[{id:'test:video',mediaKind:'video',path:'assets/fixture.mp4',bytes,sha256,license:'CC0-1.0'}]};
 async function stage(name){const path=join(root,name);await mkdir(join(path,'assets'),{recursive:true});await copyFile(video,join(path,'assets/fixture.mp4'));return path;}
 const cold=await stage('cold'),first=structuredClone(base);const result=await populateCreativePreviews(cold,first,{ffmpeg,ffprobe});assert.equal(result.generated,1);assert.equal(result.reused,0);assert.equal(first.assets[0].sha256,sha256);assert.equal(first.assets[0].license,'CC0-1.0');
 assert.equal(JSON.stringify(result).includes(root),false);assert.equal(JSON.stringify(result).includes('filename'),false);
 await writeFile(join(cold,'editkin-pack.json'),JSON.stringify(first));
 const warm=await stage('warm'),second=structuredClone(base);const hit=await populateCreativePreviews(warm,second,{ffmpeg,ffprobe,cacheRoots:[cold]});assert.equal(hit.reused,1);assert.equal(hit.generated,0);assert.deepEqual(second.assets[0].derivatives,first.assets[0].derivatives);
 const stale=structuredClone(first);stale.assets[0].derivatives.recipeSha256='0'.repeat(64);await writeFile(join(cold,'editkin-pack.json'),JSON.stringify(stale));
 assert.equal((await populateCreativePreviews(await stage('stale'),structuredClone(base),{ffmpeg,ffprobe,cacheRoots:[cold]})).generated,1);
 await writeFile(join(cold,'editkin-pack.json'),JSON.stringify(first));const poster=join(cold,first.assets[0].derivatives.poster.path);const old=await readFile(poster);await writeFile(poster,Buffer.alloc(old.length,0));
  await assert.rejects(populateCreativePreviews(await stage('tampered'),structuredClone(base),{ffmpeg,ffprobe,cacheRoots:[cold]}),/integrity/);
 await unlink(poster);
 assert.equal((await populateCreativePreviews(await stage('missing'),structuredClone(base),{ffmpeg,ffprobe,cacheRoots:[cold]})).generated,1);
 const wrongRights=structuredClone(base);wrongRights.assets[0].id='private-visual:forbidden';wrongRights.assets[0].license='PRIVATE-OWNER-ONLY';
 await assert.rejects(populateCreativePreviews(await stage('private'),wrongRights,{ffmpeg,ffprobe}),/Private\/unlicensed/);
 assert.equal(await digest(video),sha256);
});
test('NOTICE and licenses copied exactly; missing license fails, not silently omitted',async()=>{
 const root=await mkdtemp(join(tmpdir(),'creative-license-')),source=join(root,'source'),target=join(root,'target');await mkdir(join(source,'licenses'),{recursive:true});await mkdir(target);await writeFile(join(source,'NOTICE.md'),'original notice');await writeFile(join(source,'licenses','CC-BY-4.0.md'),'original license');
 assert.equal((await copyPublicAuxiliary(source,target)).length,2);assert.equal(await digest(join(source,'NOTICE.md')),await digest(join(target,'NOTICE.md')));
 const missing=join(root,'missing');await mkdir(join(missing,'licenses'),{recursive:true});await assert.rejects(copyPublicAuxiliary(missing,join(root,'other')),/Missing/);
});
