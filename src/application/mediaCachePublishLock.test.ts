import { mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withMediaCachePublishLock } from './mediaCachePublishLock';

describe('cross-process media cache publish lock',()=>{
  it('serializes independent Node processes so the second sees the committed winner',async()=>{
    const root=await mkdtemp(join(tmpdir(),'editkin-publish-lock-'));
    const target=join(root,'cache');
    const script=join(root,'worker.mjs');
    await writeFile(script,`import{withMediaCachePublishLock}from ${JSON.stringify(new URL('./mediaCachePublishLock.ts',import.meta.url).href)};import{readFile,writeFile}from'node:fs/promises';const[t,id]=process.argv.slice(2);await withMediaCachePublishLock(t,async()=>{let value;try{value=await readFile(t,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}if(!value){await new Promise(r=>setTimeout(r,120));await writeFile(t,id,{flag:'wx'});value=id;}console.log(value)});`,{flag:'wx'});
    const run=(id:string)=>new Promise<string>((ok,fail)=>{let text='',err='';const child=spawn(process.execPath,['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,script,target,id],{windowsHide:true});child.stdout.on('data',x=>text+=x);child.stderr.on('data',x=>err+=x);child.on('error',fail);child.on('close',code=>code===0?ok(text.trim()):fail(new Error(err)));});
    const values=await Promise.all([run('first'),run('second')]);expect(values[0]).toBe(values[1]);expect(await readFile(target,'utf8')).toBe(values[0]);expect((await readdir(root)).some(x=>x.endsWith('.publish-lock'))).toBe(false);
  },20_000);
  it('retains an old/unknown lock and gives readable bounded timeout',async()=>{
    const root=await mkdtemp(join(tmpdir(),'editkin-publish-lock-'));const target=join(root,'cache');let release!:()=>void;
    const started=withMediaCachePublishLock(target,async()=>new Promise<void>(r=>{release=r;}));
    while(!release)await new Promise(r=>setTimeout(r,5));
    let called=false;await expect(withMediaCachePublishLock(target,async()=>{called=true;},50)).rejects.toThrow('等待逾時');expect(called).toBe(false);
    expect(await readFile(join(`${target}.publish-lock`,'owner.json'),'utf8')).toContain('media-cache-publish-lock');release();await started;
  });
  it('quarantines bad bytes once and leaves a valid published winner untouched',async()=>{
    const root=await mkdtemp(join(tmpdir(),'editkin-publish-lock-'));const target=join(root,'cache');await writeFile(target,'bad');
    const publish=()=>withMediaCachePublishLock(target,async()=>{const current=await readFile(target,'utf8');if(current==='valid')return current;await rename(target,`${target}.invalid`);await writeFile(target,'valid',{flag:'wx'});return 'valid';});
    expect(await Promise.all([publish(),publish()])).toEqual(['valid','valid']);expect(await readFile(`${target}.invalid`,'utf8')).toBe('bad');expect(await readFile(target,'utf8')).toBe('valid');
  });
  it('callback failure releases only owned lock without deleting existing data',async()=>{
    const root=await mkdtemp(join(tmpdir(),'editkin-publish-lock-'));const target=join(root,'cache');await writeFile(target,'valid');
    await expect(withMediaCachePublishLock(target,async()=>{throw new Error('injected');})).rejects.toThrow('injected');expect(await readFile(target,'utf8')).toBe('valid');
    expect(await withMediaCachePublishLock(target,async()=> 'next')).toBe('next');
  });
});
