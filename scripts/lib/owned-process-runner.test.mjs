import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnedProcess} from './owned-process-runner.mjs';

const run=(code,timeoutMs=5000)=>runOwnedProcess(process.execPath,['-e',code],{timeoutMs});
test('success captures output only after close',async()=>{const result=await run("process.stdout.write('ready');process.stderr.write('warning')");assert.equal(result.code,0);assert.equal(result.stdout,'ready');assert.equal(result.stderr,'warning');assert.equal(result.closed,true);assert.equal(result.timedOut,false);});
test('nonzero remains failure with stderr and exact exit',async()=>{await assert.rejects(run("process.stderr.write('compiler-failure');process.exitCode=7"),error=>{assert.equal(error.result.code,7);assert.equal(error.result.closed,true);assert.equal(error.result.stderr,'compiler-failure');return true;});});
test('spawn error remains failure',async()=>{await assert.rejects(runOwnedProcess('editkin-owned-test-missing-executable-912831',[],{timeoutMs:1000}),error=>{assert.match(error.result.spawnError,/ENOENT/);assert.equal(error.result.closed,true);return true;});});
test('timeout kills exact owned parent and waits for close',async()=>{await assert.rejects(run("console.log('still-running');setInterval(()=>{},1000)",300),error=>{assert.equal(error.result.timedOut,true);assert.equal(error.result.closed,true);assert.equal(error.result.cleanup.complete,true);assert.match(error.result.stdout,/still-running/);return true;});});
test('timeout terminates descendant PID rather than only the parent',async()=>{
  let childPid;
  await assert.rejects(run("const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'inherit'});console.log('DESCENDANT:'+c.pid);setInterval(()=>{},1000)",600),error=>{
    assert.equal(error.result.timedOut,true);assert.equal(error.result.closed,true);assert.equal(error.result.cleanup.complete,true);
    childPid=Number(error.result.stdout.match(/DESCENDANT:(\d+)/)?.[1]);assert(Number.isSafeInteger(childPid)&&childPid>0);return true;
  });
  let live=true;for(let i=0;i<30;i++){try{process.kill(childPid,0);}catch(error){assert.equal(error.code,'ESRCH');live=false;break;}await new Promise(r=>setTimeout(r,30));}
  assert.equal(live,false,'Owned descendant remains alive');
});
