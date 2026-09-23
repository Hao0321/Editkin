import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NATIVE_SHARED_PROCESS_INPUTS } from "./native-shared-inputs.mjs";
import { runOwnedProcess } from "./owned-process-runner.mjs";
import { PRODUCT_REQUIRED_INPUT_PATHS } from "./build-input-identity.mjs";

const root=resolve(import.meta.dirname,"../..");
test("actual native producer and freshness verifier agree on the full input identity without promotion",async(t)=>{
  const protectedPath=resolve(root,"native/bin/win32-x64/hao-core.exe");
  const hash=b=>createHash("sha256").update(b).digest("hex");
  const before=hash(await readFile(protectedPath));
  const r=await runOwnedProcess(process.execPath,[resolve(root,"scripts/build-native-core.mjs"),"--inputs-only"],{cwd:root,timeoutMs:10000});
  const inventory=JSON.parse(r.stdout);
  assert.equal(r.code,0);assert.equal(r.closed,true);
  for(const path of [...NATIVE_SHARED_PROCESS_INPUTS,"scripts/lib/cargo-artifact-path.mjs","scripts/lib/native-shared-inputs.mjs"]){
    const entry=inventory.files.find(f=>f.path===path);assert(entry,`missing source ${path}`);
    const bytes=await readFile(resolve(root,path));assert.equal(entry.bytes,bytes.length);assert.equal(entry.sha256,hash(bytes));
  }
  const verifier=await runOwnedProcess(process.execPath,[resolve(root,"node_modules/tsx/dist/cli.mjs"),resolve(root,"scripts/auto-roto-native-product-artifact-freshness-gate.ts"),"--self-test"],{cwd:root,timeoutMs:30000});
  const controls=JSON.parse(verifier.stdout);
  assert.equal(controls.status,"GREEN_SELF_TEST");
  assert.equal(controls.scope,"evaluator-controls-only");
  assert.equal(controls.productFreshness,"NOT_RUN");
  assert.equal(controls.missingNativeHelpersRejected,5);
  assert.equal(controls.nativeInputMutationControls,4);
  assert.equal(controls.nativeReceiptInputIdentity.files,inventory.files.length);
  assert.equal(controls.nativeReceiptInputIdentity.bytes,inventory.files.reduce((sum,entry)=>sum+entry.bytes,0));
  assert.equal(controls.nativeReceiptInputIdentity.sha256,inventory.aggregateSha256);
  t.diagnostic(JSON.stringify({producer:{pid:r.pid,code:r.code,closed:r.closed,inputSha256:inventory.aggregateSha256},verifier:{pid:verifier.pid,code:verifier.code,closed:verifier.closed,...controls}}));
  assert.equal(hash(await readFile(protectedPath)),before,"read-only inventory changed installed native binary");
});
test("product required-input policy requires every shared launcher platform and its source policy",()=>{
  for(const path of [...NATIVE_SHARED_PROCESS_INPUTS,"scripts/lib/native-shared-inputs.mjs"])assert(PRODUCT_REQUIRED_INPUT_PATHS.includes(path),path);
});
