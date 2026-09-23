import {constants} from 'node:fs';
import {copyFile,mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,sep} from 'node:path';
import {digest,previewColor,run} from '../build-personal-visual-pack.mjs';
import {OWNER_VISUAL_GRANT,validatePublicAssetRights,validatePublicGrant} from '../../src/shared/visualAssetRights.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeFile(file){return file&&/^previews\/[a-f0-9]{20}\/(poster\.jpg|preview\.mp4)$/.test(file.path)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&/^[a-f0-9]{64}$/.test(file.sha256);}
async function checked(root,file){
 const base=await realpath(root),path=await realpath(resolve(base,file.path));
 if(!path.startsWith(base+sep)||(await stat(path)).size!==file.bytes||await digest(path)!==file.sha256)throw Error('Creative preview cache integrity failure');
 return path;
}
/** Owned new stage only. Originals/rights are immutable; caller commits manifest last. */
export async function populateCreativePreviews(stage,manifest,{ffmpeg,ffprobe,cacheRoots=[]}){
 try{validatePublicGrant(manifest,{documentSha256:manifest.ownerVisualGrant?await digest(join(stage,OWNER_VISUAL_GRANT.document.path)):undefined});}
 catch(error){throw Error(`Private/unlicensed source in public previews: ${error.message}`);}
 const toolIdentity={ffmpeg:await digest(ffmpeg),ffprobe:await digest(ffprobe)};
 const recipeSha256=hash({schema:'editkin.creative-preview-recipe/v1',producer:await digest(new URL(import.meta.url)),colorFunction:previewColor.toString(),width:480,height:480,fps:15,maxDuration:6,encoder:'libx264',preset:'veryfast',crf:27,pixelFormat:'yuv420p',posterAt:.3,posterQ:3});
 const caches=[];
 for(const root of cacheRoots){
  try{const m=JSON.parse(await readFile(join(root,'editkin-pack.json'),'utf8'));if(m.schemaVersion===1&&Array.isArray(m.assets))caches.push({root,assets:m.assets});}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const rows=[];
 for(const asset of manifest.assets.filter(a=>a.mediaKind==='video')){
  try{validatePublicAssetRights(asset,manifest.ownerVisualGrant);}catch(error){throw Error(`Private/unlicensed source in public previews: ${error.message}`);}
  const source=await realpath(resolve(stage,asset.path)),base=await realpath(stage);
  if(!source.startsWith(base+sep)||(await stat(source)).size!==asset.bytes||await digest(source)!==asset.sha256)throw Error('Staged original mismatch');
  const key=hash(asset.id).slice(0,20),folder=join(stage,'previews',key);await mkdir(folder,{recursive:true});
  const media=join(folder,'preview.mp4'),poster=join(folder,'poster.jpg');
  let reused=false;
  for(const cache of caches){
   const old=cache.assets.find(a=>a.id===asset.id),d=old?.derivatives;
   if(!d||old.sha256!==asset.sha256||old.license!==asset.license||d.sourceSha256!==asset.sha256||d.recipeSha256!==recipeSha256||JSON.stringify(d.toolIdentity)!==JSON.stringify(toolIdentity)||!safeFile(d.poster)||!safeFile(d.media))continue;
   const expected=hash({source:asset.sha256,media:d.media.sha256,poster:d.poster.sha256,toolIdentity,recipeSha256});if(d.revision!==expected)throw Error('Creative preview cache revision mismatch');
   let mediaSource,posterSource;
   try{mediaSource=await checked(cache.root,d.media);posterSource=await checked(cache.root,d.poster);}
   catch(error){if(error.code==='ENOENT')continue;throw error;}
   await copyFile(mediaSource,media,constants.COPYFILE_EXCL);await copyFile(posterSource,poster,constants.COPYFILE_EXCL);
   if(await digest(media)!==d.media.sha256||await digest(poster)!==d.poster.sha256)throw Error('Copied preview mismatch');
   asset.derivatives={...d,media:{...d.media,path:`previews/${key}/preview.mp4`},poster:{...d.poster,path:`previews/${key}/poster.jpg`}};
   rows.push({id:asset.id,sourceSha256:asset.sha256,reused:true});reused=true;break;
  }
  if(reused)continue;
  const metadata=JSON.parse((await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',source])).stdout),video=metadata.streams.find(s=>s.codec_type==='video');
  const duration=Number(video?.duration??metadata.format?.duration);if(!video||!Number.isFinite(duration)||duration<=0)throw Error('Invalid source video');
  const color=previewColor(video),args=['-v','error','-nostdin','-n','-i',source,'-t',String(Math.min(6,duration)),'-map','0:v:0','-an','-vf',[...color.filters,'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2','setsar=1','fps=15','format=yuv420p'].join(','),'-c:v','libx264','-preset','veryfast','-crf','27','-map_metadata','-1',...color.tags,'-movflags','+faststart',media];
  await run(ffmpeg,args);await run(ffmpeg,['-v','error','-nostdin','-n','-ss',String(Math.min(.3,duration/2)),'-i',media,'-frames:v','1','-q:v','3',poster]);
  const file=async(path,name)=>({path:`previews/${key}/${name}`,bytes:(await stat(path)).size,sha256:await digest(path)});
  const mediaFile=await file(media,'preview.mp4'),posterFile=await file(poster,'poster.jpg');
  asset.derivatives={sourceSha256:asset.sha256,recipeSha256,toolIdentity,revision:hash({source:asset.sha256,media:mediaFile.sha256,poster:posterFile.sha256,toolIdentity,recipeSha256}),media:mediaFile,poster:posterFile};
  // Public evidence must not serialize ffprobe filename/tags/private staging paths.
  rows.push({id:asset.id,sourceSha256:asset.sha256,reused:false,
    metadata:{codec:video.codec_name,width:video.width,height:video.height,duration,
      primaries:video.color_primaries??null,transfer:video.color_transfer??null,matrix:video.color_space??null,range:video.color_range??null},
    color,mediaExit:0,posterExit:0});
 }
 const report={schema:'editkin.creative-preview-build/v1',toolIdentity,recipeSha256,videos:rows.length,reused:rows.filter(r=>r.reused).length,generated:rows.filter(r=>!r.reused).length,rows};
 await writeFile(join(stage,'preview-build-evidence.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
}
