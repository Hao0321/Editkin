import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,mkdir,readdir,lstat,statfs} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runOwnedProcess} from './lib/owned-process-runner.mjs';
import {NATIVE_SHARED_PROCESS_INPUTS} from './lib/native-shared-inputs.mjs';
const root=resolve(import.meta.dirname,'..');
const cargo=resolve(process.env.USERPROFILE,'.cargo/bin/cargo.exe');
const node=resolve(root,'vendor/node/win32-x64/node.exe');
assert.equal(resolve(process.execPath).toLowerCase(),node.toLowerCase(),'Run with pinned Node');
const paths=['src-tauri/tests/preview_process_faults.rs','src-tauri/src/creative_preview.rs','src-tauri/src/preview_service_process.rs','src-tauri/src/preview_process_platform.rs','scripts/fixtures/native-preview/child.mjs','scripts/native-preview-process-self-test.mjs','scripts/lib/native-shared-inputs.mjs',...NATIVE_SHARED_PROCESS_INPUTS];
for(const name of await readdir(resolve(root,'src-tauri/src')))if(/^preview_process_.*\.rs$/.test(name)&&!paths.includes(`src-tauri/src/${name}`))paths.push(`src-tauri/src/${name}`);
async function identity(path){const b=await readFile(path);return{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}
async function identities(){return Promise.all(paths.map(async path=>({path,...await identity(resolve(root,path))})));}
const before=await identities();
const work=await mkdtemp(resolve(root,'.rd/native-preview-process-test-'));
const target=resolve(work,'target'),markers=resolve(work,'markers');await mkdir(markers);
const report={schema:'editkin.native-preview-process-faults/v1',status:'FAIL',workspace:work,source:before,node:await identity(node),cargo:await identity(cargo),runs:[],limits:['Isolated real Rust supervisor/process tests; no Tauri application build or GUI','Cleanup poison control tests actual limiter state, not OS failure injection','No product publication/activation'],startedAt:new Date().toISOString()};
const manifest=`[package]\nname="editkin-preview-process-isolated"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[[test]]\nname="preview_process_faults"\npath=${JSON.stringify(resolve(root,'src-tauri/tests/preview_process_faults.rs').replaceAll('\\','/'))}\n[dependencies]\nserde_json="1"\nlibc="=0.2.189"\nwindows-sys={version="=0.61.2",features=["Win32_Foundation","Win32_System_Threading","Win32_System_JobObjects","Win32_System_IO","Win32_System_Pipes","Win32_Storage_FileSystem","Win32_Security"]}\n[profile.dev]\ndebug=0\nincremental=false\n`;
await writeFile(resolve(work,'Cargo.toml'),manifest,{flag:'wx'});
const env={...process.env,CARGO_TARGET_DIR:target,EDITKIN_PREVIEW_TEST_NODE:node,EDITKIN_PREVIEW_TEST_CHILD:resolve(root,'scripts/fixtures/native-preview/child.mjs'),EDITKIN_PREVIEW_TEST_MARKERS:markers};
async function run(exe,args,timeoutMs){const at=Date.now();try{const result=await runOwnedProcess(exe,args,{cwd:root,env,timeoutMs});report.runs.push({exe,args,...result,elapsedMs:Date.now()-at});return result;}catch(error){report.runs.push({exe,args,...error.result,elapsedMs:Date.now()-at});throw error;}}
try{
  const serviceReceipts=resolve(root,'.rd/ui-library-20260831/commercial-public-journey-glvrl2');
  const servicePaths=[];
  for(const number of ['004','005']) {
    const receiptPath=resolve(serviceReceipts,`${number}-service-resolve_creative_preview.json`);
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    assert.equal((await identity(receipt.executable.path)).sha256,receipt.executable.sha256);
    assert(receipt.executable.path.includes('editkin-0.15.0-20260831-5125cdfaef3de558'));
    const expected=JSON.parse(receipt.stdout).result;
    assert.equal((await identity(expected.absolutePath)).sha256,expected.sha256);
    servicePaths.push(receiptPath,receipt.executable.path,...receipt.argv,expected.absolutePath);
  }
  const serviceIdentity=await Promise.all([...new Set(servicePaths)].map(async path=>({path,...await identity(path)})));
  report.packagedServiceIdentity=serviceIdentity;
  await run(cargo,['test','--offline','--manifest-path',resolve(work,'Cargo.toml'),'--no-run'],120000);
  const dep=resolve(target,'debug/deps');const binaries=(await readdir(dep)).filter(n=>/^preview_process_faults-[a-f0-9]+\.exe$/.test(n));assert.equal(binaries.length,1);
  const exe=resolve(dep,binaries[0]);report.testExecutable={path:exe,...await identity(exe)};
  const replayDeadline=Date.now()+120000;
  for(let replay=1;replay<=3;replay++) {
    const replayMarkers=resolve(work,`markers-replay-${replay}`);await mkdir(replayMarkers);
    env.EDITKIN_PREVIEW_TEST_MARKERS=replayMarkers;
    const remaining=replayDeadline-Date.now();assert(remaining>0,'Overall replay deadline exceeded');
    const result=await run(exe,['--test-threads=1','--nocapture'],remaining);assert.match(result.stdout,/test result: ok/);
    report.runs.at(-1).replay=replay;
  }
  env.EDITKIN_PREVIEW_SERVICE_RECEIPTS=serviceReceipts;
  const serviceResult=await run(exe,['--ignored','--exact','packaged_5125_poster_and_media_use_actual_supervisor','--nocapture'],40000);
  assert.match(serviceResult.stdout,/test result: ok/);
  for(const original of serviceIdentity)assert.deepEqual({path:original.path,...await identity(original.path)},original,'Packaged service or retained evidence drift');
  assert.deepEqual(await identities(),before,'Source changed during test');report.status='PASS_ISOLATED_SUPERVISOR_NOT_NATIVE_GUI';
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{
  let bytes=0;const pending=[work];while(pending.length){const p=pending.pop(),s=await lstat(p);assert(!s.isSymbolicLink());if(s.isDirectory())for(const n of await readdir(p))pending.push(join(p,n));else bytes+=s.size;}
  report.retainedLogicalBytes=bytes;const space=await statfs(root);report.finalFreeBytes=space.bavail*space.bsize;
  await writeFile(resolve(work,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,workspace:work,report:resolve(work,'report.json'),error:report.error,retainedLogicalBytes:bytes}));
}
