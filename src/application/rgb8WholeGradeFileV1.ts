import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open,lstat,readdir,mkdtemp,link,unlink,rmdir,statfs} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import type {EditProject} from '../domain/types';
import {captureWholeGradeCubeV1} from '../domain/wholeGradeCubeSnapshotV1';
import {rgb8CubeTextBlocksV1} from '../color/rgb8CubeTextStreamV1';
import {rgb8CubePlanePipeV1,type Rgb8PlanePipeReceiptV1} from '../render/rgb8CubePlanePipeV1';
import {prepareRgb8WholeGradePlanePlanV1,rgb8PlainPathV1} from './rgb8WholeGradePlanePlanV1';

const MiB=1024*1024,sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
type Owned={path:string;dev:number;ino:number;sha256?:string};
export interface Rgb8WholeGradeFileRuntimeV1 {
  /** Host-owned dedicated local root; no renderer-supplied executable or arbitrary output path. */
  artifactRoot:string;ffmpegPath:string;ffmpegSha256:string;lutRoot?:string;
  size?:number;maximumBytes?:number;quotaBytes?:number;reserveBytes?:number;timeoutMs?:number;
  signal?:AbortSignal;onSpawn?:(value:{pid:number;startedUtc:string})=>void;
  onReceipt?:(value:Rgb8PlanePipeReceiptV1)=>void;
}
async function digestFile(path:string,maximum:number){
  await rgb8PlainPathV1(path,false);const info=await lstat(path);if(info.size>maximum)throw Error('RGB8 調色檔案超過容量上限。');
  const hash=createHash('sha256');let bytes=0;for await(const block of createReadStream(path)){bytes+=block.length;if(bytes>maximum)throw Error('RGB8 調色檔案超過容量上限。');hash.update(block);}if(bytes!==info.size)throw Error('RGB8 調色檔案已變更。');return{bytes,sha256:hash.digest('hex')};
}
async function usage(root:string,exclude:string[]){
  const names=await readdir(root);if(names.length>4096)throw Error('RGB8 調色輸出目錄超過上限。');let bytes=0;
  for(const name of names){const path=join(root,name);if(exclude.includes(path))continue;await rgb8PlainPathV1(path,false);bytes+=(await lstat(path)).size;}return bytes;
}
async function removeOwned(file:Owned,root:string,maximum:number){
  const scope=relative(resolve(root),resolve(file.path));if(!scope||scope.startsWith('..')||isAbsolute(scope))throw Error('RGB8 調色暫存身分不符；已保留。');
  await rgb8PlainPathV1(file.path,false);const info=await lstat(file.path);
  if(info.dev!==file.dev||info.ino!==file.ino||info.size>maximum||!file.sha256||(await digestFile(file.path,maximum)).sha256!==file.sha256)throw Error('RGB8 調色暫存身分不符；已保留。');await unlink(file.path);
}
/** Source-only bounded file producer. It evaluates the unchanged public compositor
 * on decoded opaque RGB8 vertices. It does not certify arbitrary FLOAT/HDR input,
 * source-film parity, interpolation between vertices, or installed desktop support. */
export async function exportRgb8WholeGradeFileV1(project:EditProject,clipId:string,playhead:number,runtime:Rgb8WholeGradeFileRuntimeV1){
  runtime.signal?.throwIfAborted();const snapshot=captureWholeGradeCubeV1(project,clipId,playhead);
  const size=runtime.size??256,maximum=runtime.maximumBytes??512*MiB,quota=runtime.quotaBytes??1024*MiB,reserve=runtime.reserveBytes??64*MiB;
  const estimate=27*size**3+512,overhead=16*MiB+128*1024;
  if(!Number.isInteger(size)||size<2||size>256||!Number.isSafeInteger(maximum)||maximum<=0||maximum>512*MiB||estimate>maximum||!Number.isSafeInteger(quota)||quota<=0||quota>1024*MiB||!Number.isSafeInteger(reserve)||reserve<0||reserve>1024*MiB)throw Error('RGB8 調色工作預算不合法。');
  const root=resolve(runtime.artifactRoot);await rgb8PlainPathV1(runtime.artifactRoot,true);
  const leasePath=join(root,'.rgb8-export.lock'),token=JSON.stringify({id:randomUUID(),pid:process.pid}),lease=await open(leasePath,'wx',0o600);
  const leaseStat=await lease.stat(),leaseOwner:Owned={path:leasePath,dev:leaseStat.dev,ino:leaseStat.ino};
  let job:string|undefined,child:Rgb8PlanePipeReceiptV1|undefined,committed=false;
  const owned:Owned[]=[],published:Owned[]=[];
  try{
    await lease.writeFile(token);await lease.sync();leaseOwner.sha256=sha(token);await lease.close();
    const existing=await usage(root,[leasePath]),free=await statfs(root,{bigint:true});
    if(existing+estimate+overhead>quota||free.bavail*free.bsize<BigInt(estimate+overhead+reserve))throw Error('RGB8 調色輸出空間不足。');
    runtime.signal?.throwIfAborted();job=await mkdtemp(join(root,'.rgb8-job-'));await rgb8PlainPathV1(job,true);
    const plan=await prepareRgb8WholeGradePlanePlanV1(project,clipId,playhead,{size,planeCount:size,jobRoot:job,lutRoot:runtime.lutRoot,signal:runtime.signal,snapshot,onOwnedFile:file=>{const previous=owned.find(v=>v.path===file.path);previous?Object.assign(previous,file):owned.push(file);}});
    for(const file of plan.created){const owner=owned.find(v=>v.path===file.path);if(owner)owner.sha256=file.sha256;}
    const stagePath=join(job,'output.cube'),stage=await open(stagePath,'wx',0o600),identity=await stage.stat(),stageOwner:Owned={path:stagePath,dev:identity.dev,ino:identity.ino};owned.push(stageOwner);
    const hash=createHash('sha256');let bytes=0,writeFailed=false;
    const args=['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_complex_threads','1','-f','rawvideo','-pixel_format','rgb24','-video_size',`${size}x${size}`,'-framerate','30','-i','pipe:0','-filter_complex',plan.graph,'-map','[rgb8out]','-an','-frames:v',String(size),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'];
    try{
      const planes=rgb8CubePlanePipeV1({ffmpegPath:runtime.ffmpegPath,ffmpegSha256:runtime.ffmpegSha256,args,size,timeoutMs:runtime.timeoutMs??120000,signal:runtime.signal,onSpawn:runtime.onSpawn,onReceipt:receipt=>{child=receipt;runtime.onReceipt?.(receipt);}});
      for await(const block of rgb8CubeTextBlocksV1(size,planes,{maximumBytes:maximum,title:'Editkin decoded RGB8 grade map',signal:runtime.signal})){
        runtime.signal?.throwIfAborted();if(bytes+block.byteLength>maximum)throw Error('RGB8 調色檔案超過容量上限。');
        try{await stage.writeFile(block);}catch(error){writeFailed=true;throw error;}hash.update(block);bytes+=block.byteLength;
      }
      if(!child?.closed||child.code!==0||child.outputFrames!==size||child.outputBytes!==size**3*3)throw Error('RGB8 調色色片回讀不完整。');await stage.sync();
    }finally{await stage.close();if(!writeFailed)stageOwner.sha256=hash.digest('hex');}
    runtime.signal?.throwIfAborted();
    for(const resource of plan.resources){const current=await digestFile(resource.path,64*MiB);if(current.sha256!==resource.sha256||current.bytes!==resource.bytes)throw Error('RGB8 調色素材已變更。');}
    const cubeIdentity=await digestFile(stagePath,maximum);if(cubeIdentity.bytes!==bytes||cubeIdentity.sha256!==stageOwner.sha256)throw Error('RGB8 調色檔案已變更。');
    await rgb8PlainPathV1(root,true);let current=await usage(root,[leasePath,job]);for(const file of owned)current+=(await lstat(file.path)).size;if(current+128*1024>quota)throw Error('RGB8 調色輸出空間不足。');
    const name=`rgb8-${randomUUID()}`,artifactPath=join(root,name+'.cube'),receiptPath=join(root,name+'.json');
    const receipt={schema:'editkin.rgb8-whole-grade-file/v1',snapshotSha256:plan.snapshotSha256,inputBasis:plan.inputBasis,size,vertexCount:size**3,fullByteGrid:size===256,
      artifact:{path:artifactPath,...cubeIdentity},resources:plan.resources,attributions:plan.attributions,child,
      limits:{maximumBytes:maximum,quotaBytes:quota,planeBytes:size*size*3,writerBlockBytes:65536,reserveBytes:reserve},
      byteOutputGuard:'quarter-code;clampedRGB8;notFLOAT-or-partial-strength-parity',omittedSpatial:plan.omittedSpatial,
      excluded:['geometry','alpha','other-layers','animation'],sourceMovieMeasured:false,originalFloatCaseComplete:false,installedNativeGUI:false,interpolationBetweenVerticesMeasured:false};
    const text=JSON.stringify(receipt,null,2)+'\n';if(Buffer.byteLength(text)>128*1024)throw Error('RGB8 調色收據超過容量上限。');
    const metadataPath=join(job,'receipt.json'),metadata=await open(metadataPath,'wx',0o600),metaStat=await metadata.stat(),metaOwner:Owned={path:metadataPath,dev:metaStat.dev,ino:metaStat.ino};owned.push(metaOwner);
    try{await metadata.writeFile(text);await metadata.sync();metaOwner.sha256=sha(text);}finally{await metadata.close();}
    // Hard-link publication is same-volume and fails if the target already exists.
    // The cube is the commit marker; its receipt is durable before the cube appears.
    runtime.signal?.throwIfAborted();await link(metadataPath,receiptPath);published.push({...metaOwner,path:receiptPath});
    await link(stagePath,artifactPath);published.push({...stageOwner,path:artifactPath});committed=true;
    return{artifactPath,receiptPath,receipt,snapshot:plan.snapshot};
  }catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{rgb8Child:child,committedArtifact:committed?published.map(v=>v.path):undefined});}
  finally{
    await lease.close();
    if(!committed)for(const file of published.reverse())await removeOwned(file,root,maximum);
    if(job){await rgb8PlainPathV1(job,true);if(dirname(job)!==root)throw Error('RGB8 調色工作目錄不合法。');for(const file of owned.reverse())await removeOwned(file,job,Math.max(maximum,16*MiB));await rmdir(job);}
    await removeOwned(leaseOwner,root,1024);
  }
}
