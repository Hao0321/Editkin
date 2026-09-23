import {build} from "esbuild";
import {readFile,lstat,mkdir,writeFile,rename,realpath} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {resolve,dirname,basename,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
const defaultRoot=fileURLToPath(new URL("../../",import.meta.url));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
async function readInputs(root){
  const base=resolve(root,"src/application"),listPath=resolve(base,"materialColorImplementationPaths.json");
  const listStat=await lstat(listPath);if(!listStat.isFile()||listStat.isSymbolicLink()||listStat.size>65536)throw Error("invalid-material-color-build-inputs");
  const sourceRoot=await realpath(resolve(root,"src"));
  const list=JSON.parse(await readFile(listPath,"utf8"));
  // 33 includes the shared display-transfer implementation. Runtime validation
  // still requires the exact ordered registry; this is only an allocation cap.
  if(!Array.isArray(list)||!list.length||list.length>33||new Set(list).size!==list.length)throw Error("invalid-material-color-build-inputs");
  return Promise.all(list.map(async name=>{
    if(typeof name!=="string"||name.includes("\\")||isAbsolute(name))throw Error("invalid-material-color-build-input-path");
    const path=resolve(base,name),scope=relative(resolve(root,"src"),path);
    if(scope.startsWith("..")||isAbsolute(scope))throw Error("outside-material-color-build-input");
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error("invalid-material-color-build-input-file");
    const actualScope=relative(sourceRoot,await realpath(path));if(actualScope.startsWith("..")||isAbsolute(actualScope))throw Error("aliased-material-color-build-input");
    return {name,sha256:digest(await readFile(path))};
  }));
}
/** Build one ESM Node bundle; emitted bytes and sidecar are one integrity unit.
 * Not a signer/installer attestation. Never repairs hashes on an old output. */
export async function buildMaterialColorBundle(options){
  const root=resolve(options.absWorkingDir??defaultRoot),outfile=resolve(root,options.outfile??"");
  if(!options.outfile||options.splitting||options.outdir||options.format&&options.format!=="esm"||options.platform&&options.platform!=="node")throw Error("material-color-single-esm-bundle-required");
  const before=await readInputs(root);
  const result=await build({...options,absWorkingDir:root,bundle:true,format:"esm",platform:"node",target:options.target??"node22",outfile,write:false,metafile:true,define:{...options.define,__EDITKIN_MATERIAL_COLOR_BUILD__:JSON.stringify({schema:"editkin.material-color-build/v1",implementations:before})}});
  if(result.outputFiles.length!==1||resolve(result.outputFiles[0].path)!==outfile)throw Error("unexpected-material-color-bundle-output");
  if(JSON.stringify(before)!==JSON.stringify(await readInputs(root)))throw Error("material-color-build-input-drift");
  const bytes=result.outputFiles[0].contents;
  if(!bytes.length||bytes.length>64*1024*1024)throw Error("material-color-bundle-size-limit");
  const manifest={schema:"editkin.material-color-bundle/v1",bundle:{file:basename(outfile),size:bytes.length,sha256:digest(bytes)},implementations:before};
  const manifestBytes=JSON.stringify(manifest,null,2)+"\n";
  if(Buffer.byteLength(manifestBytes)>65536)throw Error("material-color-manifest-size-limit");
  await mkdir(dirname(outfile),{recursive:true});
  const staged=`${outfile}.${randomUUID()}.stage`,sidecar=`${outfile}.material-color-identity.json`;
  await writeFile(staged,bytes,{flag:"wx"});await writeFile(`${staged}.json`,manifestBytes,{flag:"wx"});
  // A reader between these replacements fails closed; it never falls back.
  await rename(staged,outfile);await rename(`${staged}.json`,sidecar);
  return {result,manifest,outfile,sidecar};
}
