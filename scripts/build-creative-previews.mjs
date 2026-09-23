import {constants} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,publishStage} from './build-personal-visual-pack.mjs';
import {populateCreativePreviews} from './lib/creative-preview-producer.mjs';
import {OWNER_VISUAL_GRANT,validatePublicAssetRights,validatePublicGrant} from '../src/shared/visualAssetRights.mjs';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function copyPublicAuxiliary(sourceRoot,stage){
 const paths=['NOTICE.md'];
 for(const item of await readdir(join(sourceRoot,'licenses'),{withFileTypes:true})){
  if(!item.isFile()||! /^[A-Za-z0-9_.-]+\.md$/.test(item.name))throw Error('Unexpected license entry');
  paths.push(`licenses/${item.name}`);
 }
 if(paths.length<2)throw Error('Missing public license');
 for(const path of paths){
  const source=await realpath(join(sourceRoot,path));if(!source.startsWith((await realpath(sourceRoot))+sep))throw Error('Auxiliary escape');
  const target=join(stage,path);await mkdir(dirname(target),{recursive:true});await copyFile(source,target,constants.COPYFILE_EXCL);
  if(await digest(source)!==await digest(target))throw Error('Auxiliary copy mismatch');
 }
 return paths;
}
export async function buildCreativePreviews(sourceRoot,outputRoot){
 sourceRoot=await realpath(sourceRoot);outputRoot=resolve(outputRoot);
 const raw=await readFile(join(sourceRoot,'editkin-pack.json'),'utf8'),manifest=JSON.parse(raw);
 if(manifest.schemaVersion!==1||manifest.assetCount!==manifest.assets?.length||manifest.source?.privateImagesEmbedded||manifest.portability?.privateWorkspaceEmbedded||manifest.portability?.originalPrivateReferencesEmbedded||!manifest.portability?.relativePathsOnly)throw Error('Not a public portable pack');
 validatePublicGrant(manifest,{documentSha256:manifest.ownerVisualGrant?await digest(join(sourceRoot,OWNER_VISUAL_GRANT.document.path)):undefined});
 try{await stat(outputRoot);throw Error('Output exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(dirname(outputRoot),{recursive:true});const stage=await mkdtemp(join(dirname(outputRoot),'.creator-preview-stage-')),ids=new Set();
 for(const asset of manifest.assets){
  validatePublicAssetRights(asset,manifest.ownerVisualGrant);
  if(ids.has(asset.id)||!/^assets\/[a-zA-Z0-9_./-]+$/.test(asset.path)||asset.path.split('/').some(p=>p==='..'||p==='.'||!p))throw Error('Unsafe/public metadata');ids.add(asset.id);
  const source=await realpath(resolve(sourceRoot,asset.path));if(!source.startsWith(sourceRoot+sep))throw Error('Source escape');
  if((await stat(source)).size!==asset.bytes||await digest(source)!==asset.sha256)throw Error('Source identity mismatch');
  const target=resolve(stage,asset.path);await mkdir(dirname(target),{recursive:true});await copyFile(source,target,constants.COPYFILE_EXCL);if(await digest(target)!==asset.sha256)throw Error('Copy mismatch');
 }
 const auxiliary=await copyPublicAuxiliary(sourceRoot,stage);
 const report=await populateCreativePreviews(stage,manifest,{ffmpeg:resolve(app,'vendor/ffmpeg/win32-x64/ffmpeg.exe'),ffprobe:resolve(app,'vendor/ffmpeg/win32-x64/ffprobe.exe'),cacheRoots:[sourceRoot]});
 if(await readFile(join(sourceRoot,'editkin-pack.json'),'utf8')!==raw)throw Error('Source manifest drift');
 for(const asset of manifest.assets)if(await digest(resolve(sourceRoot,asset.path))!==asset.sha256)throw Error('Source final hash drift');
 await writeFile(join(stage,'editkin-pack.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
 await publishStage(stage,outputRoot,'editkin-pack.json');return {outputRoot,auxiliary,videos:report.videos,reused:report.reused,generated:report.generated};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--source-root'||args[2]!=='--output-root')throw Error('Usage: --source-root PATH --output-root PATH');
 console.log(JSON.stringify(await buildCreativePreviews(args[1],args[3])));
}
