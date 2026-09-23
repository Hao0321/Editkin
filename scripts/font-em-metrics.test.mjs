import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFontEmMetrics} from './lib/font-em-metrics.mjs';
import {deriveFontEmMetrics,verifyFontEmMetrics} from './lib/font-em-metrics-manifest.mjs';
import {fileURLToPath} from 'node:url';
const root=new URL('../public/fonts/',import.meta.url),manifestBytes=await readFile(new URL('editkin-open-fonts.json',root)),manifest=JSON.parse(manifestBytes);
const generated=JSON.parse(await readFile(new URL('../src/generated/fontEmMetrics.json',import.meta.url)));
test('all 43 metric records are bound to actual licensed static font bytes',async()=>{
 assert.equal(generated.manifestSha256,createHash('sha256').update(manifestBytes).digest('hex'));let count=0;
 for(const f of manifest.fonts)for(const face of f.faces){const b=await readFile(new URL(face.file,root)),m=generated.faces.find(x=>x.id===face.id);assert.equal(m.sha256,createHash('sha256').update(b).digest('hex'));assert.deepEqual(m,{id:face.id,sha256:face.sha256,...readFontEmMetrics(b)});count++;}assert.equal(count,43);assert.equal(generated.faces.length,count);
});
test('invalid header, missing/truncated tables and invalid em are rejected',async()=>{
 const original=await readFile(new URL(manifest.fonts[0].faces[0].file,root));
 for(const size of [0,8,12,100])assert.throws(()=>readFontEmMetrics(original.subarray(0,size)));
 const b=Buffer.from(original);let head;for(let i=0;i<b.readUInt16BE(4);i++){const at=12+i*16;if(b.toString('ascii',at,at+4)==='head')head=b.readUInt32BE(at+8);}assert(head);b.writeUInt16BE(0,head+18);assert.throws(()=>readFontEmMetrics(b),/metric range/);
});
test('the build gate rejects changed, missing, duplicate or stale derived metrics',async()=>{
 const expected=await deriveFontEmMetrics(fileURLToPath(root));verifyFontEmMetrics(JSON.stringify(expected)+'\n',expected);
 for(const defect of ['value','missing','duplicate','manifest']){const bad=structuredClone(expected);if(defect==='value')bad.faces[0].assAscender++;if(defect==='missing')bad.faces.pop();if(defect==='duplicate')bad.faces.push(bad.faces[0]);if(defect==='manifest')bad.manifestSha256='0'.repeat(64);assert.throws(()=>verifyFontEmMetrics(JSON.stringify(bad)+'\n',expected),/stale/);}
});
