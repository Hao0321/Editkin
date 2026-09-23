import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function terminateOwnedTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({ complete:false, reason:'No owned PID' });
  if (process.platform !== 'win32') {
    try { process.kill(-pid,'SIGKILL');return Promise.resolve({complete:true}); }
    catch(error) { return Promise.resolve({complete:false,error:String(error)}); }
  }
  return new Promise(done=>{
    const killer=spawn(resolve(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);done({...value,output});};
    const timer=setTimeout(()=>{killer.kill();killer.stdout.destroy();killer.stderr.destroy();killer.unref();finish({complete:false,reason:'taskkill close timeout'});},5000);
    for(const stream of [killer.stdout,killer.stderr])stream.on('data',x=>{output=(output+x).slice(-16000);});
    killer.once('error',error=>finish({complete:false,error:String(error)}));
    killer.once('close',(code,signal)=>finish({complete:code===0&&!signal,code,signal}));
  });
}

/** Exact spawned PID-tree watchdog. Timeout/error never become successful builds.
 * Consumers must preserve output generations if completion is uncertain.
 */
export function runOwnedProcess(executable,args,{cwd,env=process.env,timeoutMs,cleanupWaitMs=10_000}={}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(cleanupWaitMs)||cleanupWaitMs<100||cleanupWaitMs>30_000)throw Error('Invalid owned process deadline');
  return new Promise((ok,fail)=>{
    const child=spawn(executable,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,spawnError,closed=false,code=null,signal=null,settled=false,cleanup,cleanupTimer;
    const result=()=>({pid:child.pid,code,signal,stdout:stdout.trim(),stderr:stderr.trim(),timedOut,closed,spawnError:spawnError?.message,cleanup});
    const finish=()=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(cleanupTimer);
      const value=result();
      if(!timedOut&&!spawnError&&closed&&code===0&&!signal)ok(value);
      else {const error=new Error(`${executable} ${timedOut?'timed out':spawnError?'spawn failed':'failed'}: ${spawnError?.message || value.stderr || value.stdout}`);error.result=value;fail(error);}
    };
    let killing;
    const stop=()=>{
      if(killing)return killing;
      cleanupTimer=setTimeout(()=>{cleanup={...cleanup,complete:false,reason:'Owned tree cleanup deadline exceeded'};child.stdout.destroy();child.stderr.destroy();child.unref();finish();},cleanupWaitMs);
      killing=terminateOwnedTree(child.pid).then(value=>{cleanup=value;if(closed)finish();});return killing;
    };
    const timer=setTimeout(()=>{timedOut=true;void stop();},timeoutMs);
    child.stdout.on('data',x=>{stdout=(stdout+x.toString()).slice(-4*1024*1024);});
    child.stderr.on('data',x=>{stderr=(stderr+x.toString()).slice(-4*1024*1024);});
    child.once('error',error=>{spawnError=error;if(child.pid)void stop();});
    child.once('exit',(exitCode,exitSignal)=>{if((exitCode!==0||exitSignal)&&!timedOut)void stop();});
    child.once('close',(exitCode,exitSignal)=>{closed=true;code=exitCode;signal=exitSignal;if(killing)void killing.then(finish);else finish();});
  });
}
