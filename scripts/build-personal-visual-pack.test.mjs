import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, previewColor, buildPersonalVisualPack,applyVisualCatalog } from './build-personal-visual-pack.mjs';
import {createHash} from 'node:crypto';

test('curation is source-bound, metadata-only and cannot rename retired history into new source identity',()=>{
 const assets=[{sourceFilename:'capcut-editing.mp4',sha256:'a'.repeat(64),path:'original.mp4',derivatives:{revision:'unchanged'},redistributable:false}];
 const catalog={schema:'editkin.private-visual-catalog/v1',distributionScope:'private-owner-only',sourceInventorySha256:createHash('sha256').update(JSON.stringify(assets.map(a=>[a.sourceFilename,a.sha256]))).digest('hex'),defaultCategory:'broll',categoryOverrides:{},names:['剪輯軟體操作']};
 const result=applyVisualCatalog(assets,catalog);
 assert.equal(result[0].sourceFilename,'capcut-editing.mp4');assert.equal(result[0].name,'剪輯軟體操作');assert.deepEqual(result[0].derivatives,assets[0].derivatives);assert.equal(assets[0].name,undefined);
 assert.throws(()=>applyVisualCatalog([{...assets[0],sha256:'b'.repeat(64)}],catalog),/invalid/);
 assert.throws(()=>applyVisualCatalog(assets,{...catalog,names:[]}),/invalid/);
});

test('closed-world enumeration includes nested/case-insensitive videos and explicitly excludes other files', async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-visual-inventory-'));
  await mkdir(join(root,'nested'));
  for(const path of ['freedom_workshop.mov','VID_20260423151917318.mp4','nested/UPPER.MP4','notes.txt'])await writeFile(join(root,path),'fixture');
  const rows=await inventory(root);
  assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.supported).length,3);
  assert.equal(rows.find(r=>r.relative==='notes.txt').supported,false);
});
test('HDR must use explicit transform; incomplete HDR cannot masquerade as Rec709; unknown remains unknown',()=>{
  for(const transfer of ['arib-std-b67','smpte2084']){
    const result=previewColor({color_transfer:transfer,color_primaries:'bt2020',color_space:'bt2020nc'});
    assert.ok(result.filters.some(f=>f.includes('tonemap')));assert.ok(result.tags.includes('bt709'));
    assert.throws(()=>previewColor({color_transfer:transfer}),/incomplete/);
  }
  assert.deepEqual(previewColor({}).filters,[]);assert.deepEqual(previewColor({}).tags,[]);
  assert.equal(previewColor({}).status,'unmeasured-source-color');
});
test('existing output is never overwritten and no encoder is launched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-visual-noclobber-'));
  await assert.rejects(buildPersonalVisualPack({sourceRoot:root,outputRoot:root,ffmpeg:'must-not-execute'}),/already exists/);
});
