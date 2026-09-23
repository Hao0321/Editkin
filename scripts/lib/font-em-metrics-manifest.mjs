import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {readFontEmMetrics} from './font-em-metrics.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function deriveFontEmMetrics(root) {
  const manifestBytes=await readFile(resolve(root,'editkin-open-fonts.json')),manifest=JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion,2);
  const faces=[];
  for(const font of manifest.fonts)for(const face of font.faces){
    assert(/^render\/EditkinFace-[a-z0-9-]+\.ttf$/.test(face.file),'Unsafe font metric source');
    const bytes=await readFile(resolve(root,face.file));assert.equal(hash(bytes),face.sha256);assert.equal(bytes.length,face.bytes);
    faces.push({id:face.id,sha256:face.sha256,...readFontEmMetrics(bytes)});
  }
  return {schema:'editkin.font-em-metrics/v1',manifestSha256:hash(manifestBytes),faces};
}

export function verifyFontEmMetrics(serialized, expected) {
  assert.equal(serialized,JSON.stringify(expected)+'\n','Font metrics are stale');
}
