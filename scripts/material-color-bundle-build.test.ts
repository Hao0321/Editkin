import {afterEach,expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename,lstat,realpath} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,basename} from "node:path";
import {buildMaterialColorBundle} from "./lib/material-color-bundle-identity.mjs";
import {readMaterialColorImplementationRegistry,verifyMaterialColorRuntimePair} from "./lib/material-color-runtime-pair.mjs";

// Each root and its alias target are owned by this fixture. rm unlinks the
// ancestor junction without following it; the absolute root is checked first.
const fixtureParent=resolve(".rd/tmp");
const roots:string[]=[];
const previousOutput="owned-previous-output";
const previousSidecar="owned-previous-sidecar";
function ownedPath(root:string,path:string):string {
  const absolute=resolve(path),scope=relative(resolve(root),absolute);
  if(!scope||scope.startsWith("..")||isAbsolute(scope))throw Error("fixture-path-outside-owned-root");
  return absolute;
}
afterEach(async()=>{
  for(const root of roots.splice(0)) {
    const absolute=ownedPath(fixtureParent,root);
    if(dirname(absolute)!==fixtureParent||(await lstat(absolute)).isSymbolicLink())throw Error("fixture-root-not-owned-directory");
    const actual=await realpath(absolute);
    if((process.platform==="win32"?actual.toLowerCase():actual)!==(process.platform==="win32"?absolute.toLowerCase():absolute))throw Error("fixture-root-aliased");
    await rm(absolute,{recursive:true,force:true});
  }
});

async function fixture(){
  await mkdir(fixtureParent,{recursive:true});
  const root=await mkdtemp(join(fixtureParent,"color-build-guard-"));
  roots.push(root);
  const source=join(root,"src/application");
  const names=[...await readMaterialColorImplementationRegistry()];
  await mkdir(source,{recursive:true});
  for(const name of names) {
    const path=ownedPath(root,resolve(source,name));
    await mkdir(dirname(path),{recursive:true});
    const text=name==="materialColorImplementationPaths.json"?JSON.stringify(names):name.endsWith(".json")?"{}\n":"export const sample = 1;\n";
    await writeFile(path,text);
  }
  // Preserve the complete current ordered registry, including its own entry.
  await writeFile(join(source,"materialColorImplementationPaths.json"),JSON.stringify(names));
  const outfile=join(root,"output.mjs"),sidecar=`${outfile}.material-color-identity.json`;
  await writeFile(outfile,previousOutput);
  await writeFile(sidecar,previousSidecar);
  const registeredSource=names.find(name=>name.endsWith(".ts")&&!name.startsWith("../"));
  if(!registeredSource)throw Error("fixture-canonical-typescript-source-missing");
  return {root,source,names,outfile,sidecar,entry:ownedPath(root,resolve(source,registeredSource))};
}
async function previousArtifactsRemain(f:Awaited<ReturnType<typeof fixture>>){
  expect(await readFile(f.outfile,"utf8")).toBe(previousOutput);
  expect(await readFile(f.sidecar,"utf8")).toBe(previousSidecar);
}

it("rejects split builds before replacing an existing output",async()=>{
  const f=await fixture();
  await expect(buildMaterialColorBundle({absWorkingDir:f.root,entryPoints:[f.entry],outfile:f.outfile,splitting:true})).rejects.toThrow("single-esm");
  await previousArtifactsRemain(f);
});

it.each(["traversal","duplicate","unknown-file"])("rejects %s source registry without artifact mutation",async mode=>{
  const f=await fixture(),list=[...f.names];
  if(mode==="traversal")list[0]="../../../outside.ts";
  else if(mode==="duplicate")list[1]=list[0];
  else list[0]="unknown-fixture.ts";
  await writeFile(join(f.source,"materialColorImplementationPaths.json"),JSON.stringify(list));
  await expect(buildMaterialColorBundle({absWorkingDir:f.root,entryPoints:[f.entry],outfile:f.outfile})).rejects.toThrow(mode==="traversal"?"outside-material-color-build-input":"invalid-material-color-build-inputs");
  await previousArtifactsRemain(f);
});

it("rejects ancestor alias escaping source root",async()=>{
  const f=await fixture();
  const registeredName=f.names.find(name=>name.startsWith("../color/")&&name.endsWith(".ts"));
  if(!registeredName)throw Error("fixture-canonical-color-source-missing");
  const registeredPath=ownedPath(f.root,resolve(f.source,registeredName));
  const ancestor=ownedPath(f.root,dirname(registeredPath));
  const outside=ownedPath(f.root,join(f.root,"owned-outside-color"));
  const relativeSource=relative(ancestor,registeredPath);
  const sourceBefore=await readFile(registeredPath,"utf8");
  // Move only our populated registered ancestor, then alias it to an owned
  // directory outside src. Membership remains exactly canonical throughout.
  await rename(ancestor,outside);
  await symlink(outside,ancestor,process.platform==="win32"?"junction":"dir");
  expect(JSON.parse(await readFile(join(f.source,"materialColorImplementationPaths.json"),"utf8"))).toEqual(f.names);
  await expect(buildMaterialColorBundle({absWorkingDir:f.root,entryPoints:[f.entry],outfile:f.outfile})).rejects.toThrow("aliased-material-color-build-input");
  expect(await readFile(join(outside,relativeSource),"utf8")).toBe(sourceBefore);
  await previousArtifactsRemain(f);
});

it("refuses input drift during esbuild rather than refreshing failed output hashes",async()=>{
  const f=await fixture();let compilerEndCalls=0;
  await expect(buildMaterialColorBundle({absWorkingDir:f.root,entryPoints:[f.entry],outfile:f.outfile,
    plugins:[{name:"owned-drift-control",setup(b){b.onEnd(async result=>{
      if(result.errors.length)throw Error("fixture-compiler-failed-before-drift");
      compilerEndCalls++;
      await writeFile(f.entry,"export const sample = 2;\n");
    });}}],
  })).rejects.toThrow("material-color-build-input-drift");
  expect(compilerEndCalls).toBe(1);
  expect(await readFile(f.entry,"utf8")).toBe("export const sample = 2;\n");
  await previousArtifactsRemain(f);
});

it("builds complete canonical inputs with the real compiler and a matching runtime pair",async()=>{
  const f=await fixture();let compilerEndCalls=0;
  const built=await buildMaterialColorBundle({absWorkingDir:f.root,entryPoints:[f.entry],outfile:f.outfile,
    plugins:[{name:"owned-positive-compiler-control",setup(b){b.onEnd(result=>{
      if(result.errors.length)throw Error("fixture-positive-compiler-failed");
      compilerEndCalls++;
    });}}],
  });
  expect(compilerEndCalls).toBe(1);
  expect(built.manifest.implementations.map(item=>item.name)).toEqual(f.names);
  expect(built.manifest.bundle.file).toBe(basename(f.outfile));
  expect((await verifyMaterialColorRuntimePair(f.outfile)).bundleSha256).toBe(built.manifest.bundle.sha256);
  expect(JSON.parse(await readFile(f.sidecar,"utf8"))).toEqual(built.manifest);
  expect(await readFile(f.outfile,"utf8")).not.toBe(previousOutput);
});
