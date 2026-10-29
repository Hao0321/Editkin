import {lstat,realpath,mkdir,mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {wholeGradeRgba16ReadbackV2} from './wholeGradeReadbackV2';
import {join,resolve,dirname,isAbsolute,relative} from 'node:path';
import {createHash} from 'node:crypto';
import type {EditProject,TimelineClip} from '../domain/types';
import {captureWholeGradeCubeV1,type WholeGradeCubeSnapshotV1} from '../domain/wholeGradeCubeSnapshotV1';
import {wholeGradeAtlasV1,unpackWholeGradeAtlasV1,wholeGradeAtlasCubeV1} from '../color/wholeGradeCubeAtlasV1';
import {compositorSourceColorPlan} from '../render/sourceColorFilters';
import {hasPrimaryToneAdjustment} from '../render/ffmpegExpressions';
import {primaryToneFilters,primaryExposureFilter,resolveAcesInput,resolveInputColorSpace,acesOutputFilter,acesPrecisionBlockReason} from '../color/primaryGrade';
import {lookColorTerms} from '../render/creativeFilters';
import {gradeWorkingSpace,resolveColorGradeV2} from '../color/gradeV2';
import {bakeResolvedGradeLut,ffmpegRenderCubeText} from '../color/gradeLutBake';
import {parseCubeFile,parseCubeLut,serializeCube3d,type ParsedCube} from '../color/cubeLut';
import {ffmpegFilterPath,gradeV2LutFilters} from '../color/gradeV2Ffmpeg';
import {acesSdrOutputLutPathV1,usesAcesClipDisplayInverseV1} from '../color/acesPhoneInputV1';
import {acesDisplayInverseFor} from '../color/acesDisplayInverse';
import {hasLinearWhiteBalance} from '../color/linearWhiteBalance';
import {secondaryHslSourceNodesV1} from '../domain/secondaryHslV1Nodes';
import {desktopColorLutLibraryV1} from './colorLutDesktopLibraryV1';
import {runWholeGradeCubeProcessV1} from '../render/wholeGradeCubeProcessV1';
const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
async function plain(path:string,directory:boolean){
  if(!isAbsolute(path)||path.startsWith('\\\\'))throw Error('整套調色 LUT 工作目錄不合法。');
  for(let p=resolve(path);;p=dirname(p)){const info=await lstat(p);if(info.isSymbolicLink()||(p===resolve(path)&&!(directory?info.isDirectory():info.isFile())))throw Error('整套調色 LUT 工作目錄不合法。');if(p===dirname(p))break;}
  const actual=await realpath(path);if(resolve(actual).toLowerCase()!==resolve(path).toLowerCase())throw Error('整套調色 LUT 工作目錄不合法。');
}
async function bounded(path:string,max=64*1024*1024){await plain(path,false);const size=(await lstat(path)).size;if(size<=0||size>max)throw Error('整套調色 LUT 資源超過上限。');const bytes=await readFile(path);if(bytes.length!==size)throw Error('整套調色 LUT 資源已變更。');return bytes;}
export interface WholeGradeCubeRuntimeV1 {ffmpegPath:string;ffmpegSha256:string;workRoot:string;colorRoot?:string;lutRoot?:string;signal?:AbortSignal;size?:number;highBitDepth?:boolean;readback?:'rgba16-v2'}
/** Source-only engine, not an installed desktop API. Its LUT maps authored source RGB codes to displayed RGB codes.
 * Uses the actual FFmpeg colour prefix; spatial finishing, geometry, alpha and other layers cannot be an RGB LUT.
 * Frame-adaptive HDR tone maps and native scene-linear processors remain explicit OPEN adapters, never approximated here. */
export async function exportWholeGradeCubeV1(project:EditProject,clipId:string,playhead:number,runtime:WholeGradeCubeRuntimeV1){
  if(runtime.readback!==undefined&&(runtime.readback!=='rgba16-v2'||runtime.size!==65))throw Error('WHOLE_GRADE_RGBA16_READBACK_POLICY');
  const snapshot=captureWholeGradeCubeV1(project,clipId,playhead),started=performance.now();
  try{return await exportWholeGradeCubeAttemptV1(snapshot,runtime,30000);}
  catch(error){
    if(runtime.size!==undefined||!(error as Error&{quality?:{maximumCodeError:number;limitCodeError:number}}).quality)throw error;
    runtime.signal?.throwIfAborted();const remaining=30000-(performance.now()-started);if(remaining<=0)throw error;
    let result:Awaited<ReturnType<typeof exportWholeGradeCubeAttemptV1>>;
    try{result=await exportWholeGradeCubeAttemptV1(snapshot,{...runtime,size:129},remaining);}
    catch(nextError){throw Object.assign(nextError instanceof Error?nextError:Error(String(nextError)),{wholeGradeAdaptive:{firstSize:65,firstQuality:(error as any).quality,firstChild:(error as any).wholeGradeChild,finalSize:129,thresholdUnchanged:true}});}
    for(const r of (error as Error&{wholeGradeResources:Array<{path:string;sha256:string}>}).wholeGradeResources??[])if(!result.receipt.resources.some(v=>v.path===r.path&&v.sha256===r.sha256))throw Error('整套調色 LUT 資源已變更。');
    return{...result,receipt:{...result.receipt,adaptive:{firstSize:65,firstQuality:(error as any).quality,firstChild:(error as any).wholeGradeChild,finalSize:129,thresholdUnchanged:true as const}}};
  }
}
async function exportWholeGradeCubeAttemptV1(snapshot:WholeGradeCubeSnapshotV1,runtime:WholeGradeCubeRuntimeV1,budgetMs:number){
  runtime.signal?.throwIfAborted();const started=performance.now(),atlas=wholeGradeAtlasV1(runtime.size);
  const {asset,management,color}=snapshot,input=management.mode==='aces2'?resolveAcesInput(asset):resolveInputColorSpace(asset),space=gradeWorkingSpace(management);
  const precisionBlock=acesPrecisionBlockReason(asset,management);if(precisionBlock)throw Error(precisionBlock);
  if(input==='hlg'||input==='pq'||input==='blocked_log'||input==='linear_rec709')throw Error('此 HDR／Log／線性來源仍需要整套調色 LUT 轉換器。');
  const high=runtime.highBitDepth??management.mode==='aces2',rgba=high?'gbrap16le':'rgba',maximum=high?65535:255;
  if(typeof high!=='boolean')throw Error('整套調色 LUT 工作預算不合法。');
  const cubes=new Map<string,ParsedCube>(),resources:Array<{path:string;bytes:number;sha256:string}>=[];let sourceLutBytes=0;
  for(const node of secondaryHslSourceNodesV1(snapshot.gradeV2?.nodes??[])){
    if(!node.lut||node.enabled===false||(node.mix??1)===0||node.lut.strength<=0||cubes.has(node.lut.sha256))continue;
    if(!runtime.lutRoot)throw Error('整套調色 LUT 尚未接上個人素材庫。');
    const resolved=await desktopColorLutLibraryV1(runtime.lutRoot,{operation:'resolve',id:node.lut.id,sha256:node.lut.sha256,inputSpace:space}) as {entry:{inputSpace:string};absolutePath:string};
    const bytes=await bounded(resolved.absolutePath);sourceLutBytes+=bytes.length;
    if(sourceLutBytes>64*1024*1024)throw Error('整套調色 LUT 資源超過上限。');
    if(resolved.entry.inputSpace!==space||sha(bytes)!==node.lut.sha256)throw Error('整套調色 LUT 素材引用不符。');
    cubes.set(node.lut.sha256,parseCubeFile(bytes.toString('utf8')));resources.push({path:resolved.absolutePath,bytes:bytes.length,sha256:sha(bytes)});runtime.signal?.throwIfAborted();
  }
  const grade=resolveColorGradeV2(snapshot.gradeV2??{schema:'editkin.color-grade/v2'},space,ref=>{const cube=cubes.get(ref.sha256);if(!cube)throw Error('整套調色 LUT 素材引用不符。');return cube;});
  if(!isAbsolute(runtime.workRoot))throw Error('整套調色 LUT 工作目錄不合法。');
  await mkdir(runtime.workRoot,{recursive:true});await plain(runtime.workRoot,true);
  const job=await mkdtemp(join(runtime.workRoot,'whole-grade-'));await plain(job,true);const created:Array<{path:string;sha256:string}>=[];
  const write=async(name:string,text:string)=>{const path=join(job,name);await writeFile(path,text,{flag:'wx',mode:0o600});created.push({path,sha256:sha(text)});return path;};
  const colorResource=async(path:string)=>{if(!runtime.colorRoot)throw Error('整套調色 LUT 尚未載入色彩轉換資源。');await plain(runtime.colorRoot,true);const file=join(runtime.colorRoot,path),bytes=await bounded(file);resources.push({path:file,bytes:bytes.length,sha256:sha(bytes)});return bytes;};
  let result:Awaited<ReturnType<typeof runWholeGradeCubeProcessV1>>|undefined;
  try{
    runtime.signal?.throwIfAborted();let inversePath:string|undefined;
    const reconstruct=management.mode==='aces2'&&usesAcesClipDisplayInverseV1(resolveAcesInput(asset),management,{gradeV2:snapshot.gradeV2,rec709Input:snapshot.rec709Input},hasLinearWhiteBalance(color));
    if(reconstruct){const output=parseCubeLut((await colorResource(acesSdrOutputLutPathV1(management))).toString('utf8')),inverse=acesDisplayInverseFor(output);inversePath=await write('display-inverse.cube',serializeCube3d(inverse.values,inverse.size,'Editkin whole grade source inverse'));}
    else if(management.mode==='aces2')await colorResource(`luts/input-${input}-to-acescct.cube`);
    if(management.mode==='aces2')await colorResource(management.outputTransform==='rec709_sdr'?acesSdrOutputLutPathV1(management):`luts/output-acescct-to-${management.outputTransform}.cube`);
    const source=compositorSourceColorPlan(asset,atlas.width,atlas.height,rgba,maximum,inversePath?{...management,mode:'rec709',outputTransform:'rec709_sdr'}:management,runtime.colorRoot,color.exposure,color,'raw-source');
    const look=lookColorTerms({color,creative:snapshot.legacyLookId?{lookPresetId:snapshot.legacyLookId,effectPresetIds:[]}:undefined} as TimelineClip);
    const eq=color.brightness!==0||color.contrast!==1||color.saturation!==1||look.brightness!=='0'||look.contrast!=='1'||look.saturation!=='1';
    const filters=[...source.filters,...(inversePath?['format=gbrpf32le',`lut3d=file='${ffmpegFilterPath(inversePath)}':interp=tetrahedral`]:[]),
      ...(hasPrimaryToneAdjustment(color)?primaryToneFilters(color):[]),...(!source.exposureConsumed&&color.exposure!==0?[primaryExposureFilter(color.exposure)]:[]),
      ...(eq?[`eq=brightness='(${color.brightness})+(${look.brightness})+(0)':contrast='(${color.contrast})*(${look.contrast})':saturation='(${color.saturation})*(${look.saturation})':eval=frame`]:[]),
      ...(color.hue!==0||look.hue!=='0'?[`hue=h='(${color.hue})+(${look.hue})'`]:[])];
    if(!grade.identity){const path=await write('grade.cube',ffmpegRenderCubeText(bakeResolvedGradeLut(grade),'Editkin whole grade v2 stage',high));filters.push(...gradeV2LutFilters(path,high));}
    const output=acesOutputFilter(management,runtime.colorRoot);if(output)filters.push(output);filters.push(runtime.readback==='rgba16-v2'?'format=gbrap16le':'format=gbrp16le');
    const remaining=budgetMs-(performance.now()-started);if(remaining<=0)throw Error('整套調色 LUT 工作逾時。');
    const args=['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_threads','1','-f','rawvideo','-pixel_format','gbrpf32le','-video_size',`${atlas.width}x${atlas.height}`,'-framerate','1','-i','pipe:0','-an','-vf',filters.join(','),'-frames:v','1','-f','rawvideo','-pix_fmt',runtime.readback==='rgba16-v2'?'gbrap16le':'gbrp16le','pipe:1'];
    result=await runWholeGradeCubeProcessV1({ffmpegPath:runtime.ffmpegPath,ffmpegSha256:runtime.ffmpegSha256,args,input:atlas.bytes,maximumOutput:atlas.pixels*(runtime.readback==='rgba16-v2'?8:6),timeoutMs:remaining,signal:runtime.signal});runtime.signal?.throwIfAborted();
    for(const resource of resources)if(sha(await bounded(resource.path))!==resource.sha256)throw Error('整套調色 LUT 資源已變更。');
    const readback=runtime.readback==='rgba16-v2'?wholeGradeRgba16ReadbackV2(result.bytes,atlas.pixels):undefined;
    const baked=wholeGradeAtlasCubeV1(atlas,unpackWholeGradeAtlasV1(readback?.bytes??result.bytes,atlas),`${snapshot.sourceName} · Whole grade · ${input} to ${management.outputTransform}`);
    return{text:baked.text,size:atlas.size,quality:baked.quality,omittedSpatial:Object.keys(grade.finishing??{}),snapshot,
      receipt:{schema:'editkin.whole-grade-cube-reference/v1' as const,scope:'FFmpeg-static-colour-prefix-at-authored-sample' as const,snapshotSha256:sha(JSON.stringify(snapshot)),input,output:management.outputTransform,highBitDepth:high,filters,args,resources,
        atlas:{width:atlas.width,height:atlas.height,grid:atlas.gridCount,holdouts:512,inputBytes:atlas.bytes.length,inputSha256:sha(atlas.bytes),outputBytes:result.bytes.length,outputSha256:sha(result.bytes)},
        ...(readback?{readback:readback.receipt}:{}),
        child:{pid:result.pid,code:result.code,closed:result.closed,startedUtc:result.startedUtc,elapsedMs:result.elapsedMs,stderr:result.stderr,executableBefore:result.executableBefore,executableAfter:result.executableAfter},cubeBytes:Buffer.byteLength(baked.text),cubeSha256:sha(baked.text),quality:baked.quality,
        installedNativeGUI:false as const,sourceMediaMeasured:false as const,previewParityMeasured:false as const,nativeSceneLinearProcessorMeasured:false as const,elapsedMs:performance.now()-started}};
  }catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{wholeGradeChild:result?{pid:result.pid,closed:result.closed,code:result.code,startedUtc:result.startedUtc,elapsedMs:result.elapsedMs}:undefined,wholeGradeResources:resources});}
  finally{
    // Only these wx-created files, after the child has settled. No recursive delete, root sweep or unrelated profile cleanup.
    await plain(job,true);const scope=relative(resolve(runtime.workRoot),resolve(job));if(scope.startsWith('..')||isAbsolute(scope))throw Error('整套調色 LUT 工作目錄不合法。');
    for(const file of created){if(dirname(file.path)!==job||sha(await bounded(file.path,16*1024*1024))!==file.sha256)throw Error('整套調色 LUT 暫存內容已變更；已保留。');await unlink(file.path);}
    await rmdir(job);
  }
}
