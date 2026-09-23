import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supported = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function applyVisualCatalog(assets, catalog) {
  const sourceInventorySha256=createHash('sha256').update(JSON.stringify(assets.map(asset=>[asset.sourceFilename,asset.sha256]))).digest('hex');
  const categories=new Set(['broll','motion','transition','private_animation']);
  if(catalog.schema!=='editkin.private-visual-catalog/v1'||catalog.distributionScope!=='private-owner-only'
    ||catalog.sourceInventorySha256!==sourceInventorySha256||!categories.has(catalog.defaultCategory)
    ||!Array.isArray(catalog.names)||catalog.names.length!==assets.length||!catalog.names.every(name=>typeof name==='string'&&name.trim())
    ||!catalog.categoryOverrides||Object.entries(catalog.categoryOverrides).some(([key,value])=>!/^\d+$/.test(key)||Number(key)<1||Number(key)>assets.length||!categories.has(value)))throw new Error('Private visual catalog identity/metadata invalid');
  return assets.map((asset,index)=>{
    const category=catalog.categoryOverrides[String(index+1)]??catalog.defaultCategory;
    return {...asset,name:catalog.names[index],category,role:{broll:'supplemental-footage',motion:'motion-overlay',transition:'transition-source',private_animation:'private-animation'}[category]};
  });
}
export async function publishStage(stage, outputRoot, manifestName) {
  try { await rename(stage,outputRoot); return {mode:'directory-rename'}; }
  catch(error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }
  // Windows can deny directory renames while allowing owned-file copies.
  // Create an entirely new root, never replace existing files. The manifest is
  // the commit marker and appears only after every payload hash is verified.
  await mkdir(outputRoot);
  const rows=await inventory(stage);
  for(const row of rows.filter(row=>row.relative!==manifestName)){
    const target=join(outputRoot,row.relative);await mkdir(dirname(target),{recursive:true});
    await copyFile(row.path,target,constants.COPYFILE_EXCL);
    if(await digest(row.path)!==await digest(target))throw new Error('Stage publication copy mismatch');
  }
  const sourceManifest=join(stage,manifestName),targetManifest=join(outputRoot,manifestName);
  await copyFile(sourceManifest,targetManifest,constants.COPYFILE_EXCL);
  if(await digest(sourceManifest)!==await digest(targetManifest))throw new Error('Stage publication manifest mismatch');
  return {mode:'verified-exclusive-copy',retainedStage:stage};
}
export async function run(exe, args) {
  return new Promise((accept, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Media tool timeout')); }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? accept({ code, stdout, stderr }) : reject(new Error(`Media tool exit ${code}: ${stderr}`)); });
  });
}
export async function inventory(sourceRoot) {
  const root = await realpath(sourceRoot), rows = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : 1)) {
      if (entry.isSymbolicLink()) throw new Error('Source symlink rejected');
      const file = join(path, entry.name);
      if (!(await realpath(file)).startsWith(root + sep)) throw new Error('Source escaped root');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push({ path: file, relative: relative(root, file).replaceAll('\\', '/'), supported: supported.has(extname(file).toLowerCase()) });
    }
  }
  await visit(root); return rows;
}
export function previewColor(stream) {
  const transfer = stream.color_transfer;
  if (['arib-std-b67','smpte2084'].includes(transfer)) {
    if (stream.color_primaries !== 'bt2020' || !['bt2020nc','bt2020c'].includes(stream.color_space)) throw new Error('HDR color metadata incomplete: preserve original, do not guess');
    return { status: 'hdr-to-rec709-hable-preview-not-calibrated', filters: ['zscale=t=linear:npl=100','format=gbrpf32le','zscale=p=bt709','tonemap=tonemap=hable:desat=0','zscale=t=bt709:m=bt709:r=tv'], tags: ['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709'] };
  }
  // Unknown metadata stays unknown; no invented SDR/HDR interpretation.
  if (transfer && !['unknown','unspecified','bt709','iec61966-2-1','smpte170m','bt470m','bt470bg','gamma22','gamma28'].includes(transfer)) throw new Error(`Unsupported transfer ${transfer}`);
  const tags = [];
  for (const [field, option] of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace']]) {
    if (stream[field] && !['unknown','unspecified'].includes(stream[field])) tags.push(option, stream[field]);
  }
  return { status: transfer && transfer !== 'unknown' ? 'source-tags-preserved' : 'unmeasured-source-color', filters: [], tags };
}
export async function buildPersonalVisualPack({sourceRoot=resolve(app,'../../assets/broll/transitions'), outputRoot=resolve(app,'.personal-packs/hao-visual-library'), catalog, ffmpeg=resolve(app,'vendor/ffmpeg/win32-x64/ffmpeg.exe'), ffprobe=resolve(app,'vendor/ffmpeg/win32-x64/ffprobe.exe')}={}) {
  const before = await inventory(sourceRoot);
  // No clobber: existing owner packs require an explicit later update transaction.
  try { await stat(outputRoot); throw new Error('Output already exists; refusing overwrite'); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(outputRoot), {recursive:true});
  const stage = await mkdtemp(join(dirname(outputRoot), '.hao-visual-stage-'));
  const assets = [], evidence = [], toolIdentity = { ffmpeg: await digest(ffmpeg), ffprobe: await digest(ffprobe) };
  for (const row of before) {
    const beforeSha = await digest(row.path), sourceStat = await stat(row.path);
    if (!row.supported) { evidence.push({source:row.relative,sha256:beforeSha,bytes:sourceStat.size,included:false,reason:'unsupported-extension'}); continue; }
    const id = createHash('sha256').update(row.relative).digest('hex').slice(0,20), folder = join(stage,'assets',id);
    await mkdir(folder,{recursive:true});
    const original = join(folder,`original${extname(row.path).toLowerCase()}`);
    await copyFile(row.path,original,constants.COPYFILE_EXCL);
    if (await digest(original) !== beforeSha) throw new Error('Copy hash mismatch');
    const probe = await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',original]);
    const metadata = JSON.parse(probe.stdout), video = metadata.streams.find(s=>s.codec_type==='video');
    const duration = Number(video?.duration ?? metadata.format?.duration);
    if (!video || !Number.isFinite(duration) || duration<=0) throw new Error(`Invalid video: ${row.relative}`);
    const rotation = Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation ?? video.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation)%180===90;
    const color = previewColor(video), resize="scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2";
    const media = join(folder,'preview.mp4'), poster = join(folder,'poster.jpg');
    const mediaArgs=['-v','error','-nostdin','-n','-i',original,'-t',String(Math.min(duration,6)),'-map','0:v:0','-an','-vf',[...color.filters,resize,'setsar=1','fps=15','format=yuv420p'].join(','),'-c:v','libx264','-preset','veryfast','-crf','27','-map_metadata','-1',...color.tags,'-movflags','+faststart',media];
    const mediaRun=await run(ffmpeg,mediaArgs);
    const posterArgs=['-v','error','-nostdin','-n','-ss',String(Math.min(.3,duration/2)),'-i',media,'-frames:v','1','-q:v','3',poster];
    const posterRun=await run(ffmpeg,posterArgs);
    const file=async path=>({path:relative(stage,path).replaceAll('\\','/'),bytes:(await stat(path)).size,sha256:await digest(path)});
    const mediaFile=await file(media),posterFile=await file(poster);
    const revision=createHash('sha256').update(JSON.stringify({source:beforeSha,media:mediaFile.sha256,poster:posterFile.sha256,toolIdentity,color})).digest('hex');
    const privateAnimation=['freedom_workshop.mov','VID_20260423151917318.mp4'].includes(row.relative);
    assets.push({id:`private-visual:${id}`,name:row.relative.replace(/\.[^.]+$/,''),category:privateAnimation?'private_animation':'transition',role:privateAnimation?'private-animation':'source-library-unclassified',domains:['general'],mediaKind:'video',...await file(original),duration,width:rotated?video.height:video.width,height:rotated?video.width:video.height,license:'PRIVATE-OWNER-ONLY',rightsBasis:'private-owner-only',redistributable:false,provenance:'Owner workspace import; no public redistribution permission supplied',renderer:'media-asset',sourceFilename:row.relative,colorMetadata:{primaries:video.color_primaries??null,transfer:video.color_transfer??null,matrix:video.color_space??null,range:video.color_range??null},derivatives:{sourceSha256:beforeSha,revision,poster:posterFile,media:mediaFile}});
    const afterSha=await digest(row.path);
    if(afterSha!==beforeSha)throw new Error(`Source changed during build: ${row.relative}`);
    evidence.push({source:row.relative,included:true,beforeSha256:beforeSha,afterSha256:afterSha,bytes:sourceStat.size,probe:metadata,color,mediaArgs,mediaExit:mediaRun.code,posterArgs,posterExit:posterRun.code});
  }
  const after=await inventory(sourceRoot);
  if(JSON.stringify(before.map(r=>r.relative))!==JSON.stringify(after.map(r=>r.relative)))throw new Error('Source inventory drift');
  for(const row of after){const entry=evidence.find(e=>e.source===row.relative);if(await digest(row.path)!==(entry.beforeSha256??entry.sha256))throw new Error('Final source drift');}
  const manifest={schemaVersion:1,id:'studio.hao.personal-visual-library',name:'私人視覺素材',version:'2026.08.31',distributionScope:'private-owner-only',redistributable:false,assetCount:assets.length,assetBytes:assets.reduce((n,a)=>n+a.bytes,0),assets};
  if(catalog)manifest.assets=applyVisualCatalog(assets,JSON.parse(await readFile(catalog,'utf8')));
  await writeFile(join(stage,'editkin-personal-visual.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  await writeFile(join(stage,'build-evidence.json'),JSON.stringify({status:'BUILT_NOT_ART_APPROVED',toolIdentity,sourceRoot,closedWorld:before.length,included:assets.length,evidence},null,2),{flag:'wx'});
  await publishStage(stage,outputRoot,'editkin-personal-visual.json');
  return {outputRoot,assetCount:assets.length,manifestSha256:await digest(join(outputRoot,'editkin-personal-visual.json'))};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), options={};
  for(let i=0;i<args.length;i+=2){const key={'--source-root':'sourceRoot','--output-root':'outputRoot','--catalog':'catalog'}[args[i]];if(!key||!args[i+1])throw new Error('Usage: [--source-root PATH] [--output-root PATH] [--catalog PATH]');options[key]=resolve(args[i+1]);}
  console.log(JSON.stringify(await buildPersonalVisualPack(options)));
}
