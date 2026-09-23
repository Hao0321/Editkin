import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,readFile,lstat,mkdir,writeFile,mkdtemp,symlink} from 'node:fs/promises';
import {relative,resolve,sep} from 'node:path';
import {deriveFontEmMetrics,verifyFontEmMetrics} from './lib/font-em-metrics-manifest.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function closedWorld(actual,expected){assert.deepEqual(actual,[...expected].sort(),'Closed-world font payload mismatch');}
function safePath(value) {
  assert(typeof value==='string' && /^[A-Za-z0-9_\[\],.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(p=>p!=='.'&&p!=='..'),'Unsafe font path');return value;
}
async function inventory(root,directory=root) {
  assert(!(await lstat(directory)).isSymbolicLink(),'Font directory alias rejected');
  const out=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=resolve(directory,entry.name);assert(!entry.isSymbolicLink(),'Font symlink rejected');
    if(entry.isDirectory())out.push(...await inventory(root,path));
    else {assert(entry.isFile(),'Unknown font filesystem entry');out.push(relative(root,path).split(sep).join('/'));}
  }return out.sort();
}
function sfnt(bytes) {
  assert(bytes.length>=12&&['00010000','4f54544f'].includes(bytes.subarray(0,4).toString('hex')),'Invalid SFNT');
  const count=bytes.readUInt16BE(4),tables=new Map();assert(12+16*count<=bytes.length,'SFNT directory truncated');
  for(let i=0;i<count;i++){const at=12+i*16,tag=bytes.toString('ascii',at,at+4),offset=bytes.readUInt32BE(at+8),length=bytes.readUInt32BE(at+12);assert(!tables.has(tag)&&offset+length<=bytes.length,'SFNT table invalid');tables.set(tag,{offset,length});}
  const os2=tables.get('OS/2'),name=tables.get('name');assert(os2?.length>=8&&name?.length>=6,'Missing SFNT required table');
  const names=new Map(),base=name.offset,n=bytes.readUInt16BE(base+2),strings=bytes.readUInt16BE(base+4);assert(6+12*n<=name.length,'Name directory invalid');
  for(let i=0;i<n;i++){const p=base+6+12*i,platform=bytes.readUInt16BE(p),id=bytes.readUInt16BE(p+6),length=bytes.readUInt16BE(p+8),start=base+strings+bytes.readUInt16BE(p+10);assert(start+length<=base+name.length,'Name string invalid');if(platform===0||platform===3){assert(length%2===0);let value='';for(let k=0;k<length;k+=2)value+=String.fromCharCode(bytes.readUInt16BE(start+k));if(!names.has(id))names.set(id,[]);names.get(id).push(value);}}
  return {tables,names,weight:bytes.readUInt16BE(os2.offset+4)};
}
function verifyFace(bytes,face,font) {
  assert.equal(bytes.length,face.bytes,'Face bytes mismatch');assert.equal(hash(bytes),face.sha256,'Face hash mismatch');
  assert.equal(face.sourceSha256,font.sha256,'Face source mismatch');
  const alias=`EditkinFace ${font.id} ${face.weight}`,ps=`EditkinFace-${font.id}-${face.weight}`;
  assert.equal(face.family,alias);assert.equal(face.postscriptName,ps);assert.equal(face.id,ps);assert.equal(face.file,`render/${ps}.ttf`);
  const data=sfnt(bytes);assert(!data.tables.has('fvar'),'Static face contains fvar');assert.equal(data.weight,face.weight,'OS/2 weight mismatch');
  for(const [id,value] of [[1,alias],[4,alias],[6,ps],[16,alias]])assert(data.names.get(id)?.length && data.names.get(id).every(n=>n===value),`SFNT name ${id} mismatch`);
  return data;
}
export function generated(manifest) {
  return {index:JSON.stringify(manifest.fonts.map(f=>[f.family,f.id,f.faces.map(face=>face.weight)]))+'\n',css:manifest.fonts.flatMap(f=>f.faces.map(face=>`@font-face{font-family:"${face.family}";src:url("/fonts/${f.file}") format("truetype");font-style:normal;font-weight:${face.weight};font-display:swap;}`)).join('\n')+'\n'};
}
const args=process.argv.slice(2),root=resolve(args.find(a=>!a.startsWith('--'))??'public/fonts');
const generatedArg=args.find(a=>a.startsWith('--generated-dir='));const generatedDir=resolve(generatedArg?.split('=').slice(1).join('=')??'src/generated');
const manifest=JSON.parse(await readFile(resolve(root,'editkin-open-fonts.json'),'utf8'));
assert.equal(manifest.schemaVersion,2);assert.equal(manifest.id,'studio.hao.editkin-open-fonts');assert.equal(manifest.fonts.length,5);
assert.deepEqual(manifest.fonts.map(f=>[f.id,f.family]),[['noto-sans-tc','Noto Sans TC'],['noto-serif-tc','Noto Serif TC'],['lxgw-wenkai-mono-tc','LXGW WenKai Mono TC'],['bebas-neue','Bebas Neue'],['fredoka','Fredoka']],'Unknown or reordered logical font family');
const expected=new Set(['editkin-open-fonts.json']),families=new Set(),ids=new Set(),faces=[],sourceAxes=new Map();
function add(path){safePath(path);assert(!expected.has(path),'Duplicate path');expected.add(path);return resolve(root,path);}
const files=await inventory(root);
for(const font of manifest.fonts){
  assert(!families.has(font.family)&&!ids.has(font.id),'Duplicate font family/id');families.add(font.family);ids.add(font.id);assert.equal(font.license,'OFL-1.1');
  const source=await readFile(add(font.file));assert.equal(source.length,font.bytes);assert.equal(hash(source),font.sha256);
  const sourceData=sfnt(source),fvar=sourceData.tables.get('fvar');let weights=[400];
  const axes={};
  if(fvar){const base=fvar.offset,axesOffset=source.readUInt16BE(base+4),axisCount=source.readUInt16BE(base+8),axisSize=source.readUInt16BE(base+10);assert(axisSize>=20);let range;for(let i=0;i<axisCount;i++){const at=base+axesOffset+i*axisSize;assert(at+20<=base+fvar.length);const tag=source.toString('ascii',at,at+4);axes[tag]=[source.readInt32BE(at+4)/65536,source.readInt32BE(at+8)/65536,source.readInt32BE(at+12)/65536];if(tag==='wght')range=[axes[tag][0],axes[tag][2]];}assert(range);weights=[];for(let w=range[0];w<=range[1];w+=50)weights.push(w);}
  sourceAxes.set(font.id,axes);
  assert.deepEqual(font.faces.map(f=>f.weight),weights,'Face grid mismatch');
  const license=await readFile(add(font.licenseFile));assert.equal(hash(license),font.licenseSha256);assert(license.toString().includes('SIL OPEN FONT LICENSE Version 1.1'));
  for(const face of font.faces){const bytes=await readFile(add(face.file));verifyFace(bytes,face,font);faces.push({font,face,bytes});}
}
const provenance=await readFile(add(manifest.staticFaceProvenance.file));assert.equal(hash(provenance),manifest.staticFaceProvenance.sha256);const p=JSON.parse(provenance);assert.equal(p.schema,'editkin.static-font-provenance/v1');assert.equal(p.generatorSha256,hash(await readFile('scripts/build-static-font-pack.py')));assert(typeof p.fontToolsVersion==='string');
assert.deepEqual(p.families,manifest.fonts.map(f=>({id:f.id,sourceSha256:f.sha256,licenseSha256:f.licenseSha256,axes:sourceAxes.get(f.id),weights:f.faces.map(face=>face.weight)})),'Provenance axes/source/weight mapping differs');
closedWorld(files,expected);assert.equal(faces.length,43);
const products=generated(manifest);
const metrics=await deriveFontEmMetrics(root);
if(args.includes('--write-generated')||args.includes('--refresh-generated')){assert(generatedArg,'Explicit generated-dir required for writes');await mkdir(generatedDir,{recursive:true});const options=args.includes('--refresh-generated')?undefined:{flag:'wx'};await writeFile(resolve(generatedDir,'fontFaceIndex.json'),products.index,options);await writeFile(resolve(generatedDir,'fontFaces.css'),products.css,options);await writeFile(resolve(generatedDir,'fontEmMetrics.json'),JSON.stringify(metrics)+'\n',options);}
assert.equal(await readFile(resolve(generatedDir,'fontFaceIndex.json'),'utf8'),products.index,'Generated index differs');assert.equal(await readFile(resolve(generatedDir,'fontFaces.css'),'utf8'),products.css,'Generated CSS differs');
verifyFontEmMetrics(await readFile(resolve(generatedDir,'fontEmMetrics.json'),'utf8'),metrics);
let negatives=0;
if(args.includes('--self-test')){
  await mkdir('.rd',{recursive:true});const aliasFixture=await mkdtemp(resolve('.rd/font-gate-negative-'));await symlink(root,resolve(aliasFixture,'alias'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>inventory(aliasFixture),/symlink|alias/);negatives++;
  for(const path of ['../escape.ttf','render/../escape.ttf','C:/x.ttf','render\\x.ttf','/x.ttf','render/%2e.ttf']){assert.throws(()=>safePath(path));negatives++;}
  const {font,face,bytes}=faces[0];
  for(const defect of ['hash','weight','name','fvar']){const damaged=Buffer.from(bytes),meta=structuredClone(face);const data=sfnt(damaged);if(defect==='hash')damaged[damaged.length-1]^=1;if(defect==='weight')damaged.writeUInt16BE(face.weight+1,data.tables.get('OS/2').offset+4);if(defect==='name'){const table=data.tables.get('name');damaged.writeUInt16BE(0,table.offset+2);}if(defect==='fvar'){const count=damaged.readUInt16BE(4);for(let i=0;i<count;i++)if(damaged.toString('ascii',12+i*16,16+i*16)==='head')damaged.write('fvar',12+i*16,'ascii');}if(defect!=='hash')meta.sha256=hash(damaged);assert.throws(()=>verifyFace(damaged,meta,font));negatives++;}
  assert.throws(()=>closedWorld([...files,'unknown.ttf'],expected));negatives++;
  assert.throws(()=>closedWorld(files.slice(1),expected));negatives++;
  assert.throws(()=>add(manifest.fonts[0].faces[0].file));negatives++;
  assert.throws(()=>assert.equal(products.index+' ',products.index));negatives++;
  assert.throws(()=>assert.equal(products.css.replace('weight:100','weight:101'),products.css));negatives++;
  const badMetrics=structuredClone(metrics);badMetrics.faces[0].assAscender++;assert.throws(()=>verifyFontEmMetrics(JSON.stringify(badMetrics)+'\n',metrics));negatives++;
}
console.log(JSON.stringify({status:'VERIFIED_FONT_ASSET_CONTRACT_ONLY',root,fontCount:manifest.fonts.length,faceCount:faces.length,files:files.length,negatives}));
