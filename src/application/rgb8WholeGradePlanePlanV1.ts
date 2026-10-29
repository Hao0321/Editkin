import {readFile,open,lstat,realpath} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import type {EditProject} from '../domain/types';
import {DEFAULT_TRANSFORM} from '../domain/types';
import {createEmptyProject} from '../domain/editGraph';
import {captureWholeGradeCubeV1,type WholeGradeCubeSnapshotV1} from '../domain/wholeGradeCubeSnapshotV1';
import {resolveInputColorSpace} from '../color/primaryGrade';
import {hasLinearWhiteBalance} from '../color/linearWhiteBalance';
import {secondaryHslSourceNodesV1} from '../domain/secondaryHslV1Nodes';
import {parseCubeFile,type ParsedCube} from '../color/cubeLut';
import {resolveColorGradeV2} from '../color/gradeV2';
import {bakeResolvedGradeLut,ffmpegRenderCubeText} from '../color/gradeLutBake';
import {desktopColorLutLibraryV1} from './colorLutDesktopLibraryV1';
import {compositorVideoFilters} from '../render/ffmpegComposite';
import {buildRenderPlan} from '../render/planner';
import {compileClipAlphaPlan} from '../domain/clipAlphaPlan';
import {findLookPreset} from '../creative/corePack';
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
export async function rgb8PlainPathV1(path:string,directory:boolean){
  if(!isAbsolute(path)||path.startsWith('\\\\'))throw Error('RGB8 調色工作目錄不合法。');
  for(let p=resolve(path);;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink()||(p===resolve(path)&&!(directory?s.isDirectory():s.isFile())))throw Error('RGB8 調色工作目錄不合法。');if(p===dirname(p))break;}
  if(resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())throw Error('RGB8 調色工作目錄不合法。');
}
export async function prepareRgb8WholeGradePlanePlanV1(project:EditProject,clipId:string,playhead:number,options:{size:number;planeCount:number;jobRoot:string;lutRoot?:string;signal?:AbortSignal;snapshot?:WholeGradeCubeSnapshotV1;onOwnedFile?:(file:{path:string;dev:number;ino:number;sha256?:string})=>void}){
  options.signal?.throwIfAborted();const snapshot=options.snapshot??captureWholeGradeCubeV1(project,clipId,playhead);
  if(snapshot.management.mode!=='rec709'||snapshot.management.outputTransform!=='rec709_sdr'||resolveInputColorSpace(snapshot.asset)!=='rec709'||hasLinearWhiteBalance(snapshot.color))throw Error('此色彩流程尚未提供 RGB8 密表轉換器。');
  if(!Number.isInteger(options.size)||options.size<2||options.size>256||!Number.isInteger(options.planeCount)||options.planeCount<1||options.planeCount>256)throw Error('RGB8 調色色片參數不合法。');
  await rgb8PlainPathV1(options.jobRoot,true);const cubes=new Map<string,ParsedCube>(),resources:Array<{path:string;sha256:string;bytes:number}>=[],attributions:Array<{id:string;license:string;provenance:string;rightsBasis?:string}>=[];let bytes=0;
  for(const node of secondaryHslSourceNodesV1(snapshot.gradeV2?.nodes??[])){
    if(!node.lut||node.enabled===false||(node.mix??1)===0||node.lut.strength<=0||cubes.has(node.lut.sha256))continue;
    if(!options.lutRoot)throw Error('RGB8 調色密表尚未接上素材庫。');
    const resolved=await desktopColorLutLibraryV1(options.lutRoot,{operation:'resolve',id:node.lut.id,sha256:node.lut.sha256,inputSpace:'rec709_display'}) as {absolutePath:string;entry:{id:string;license:string;provenance:string;rightsBasis:string}};
    await rgb8PlainPathV1(resolved.absolutePath,false);const s=await lstat(resolved.absolutePath);if(s.size>64*1024*1024||(bytes+=s.size)>64*1024*1024)throw Error('RGB8 調色素材超過容量上限。');
    const content=await readFile(resolved.absolutePath);if(content.length!==s.size||sha(content)!==node.lut.sha256)throw Error('RGB8 調色素材已變更。');
    cubes.set(node.lut.sha256,parseCubeFile(content.toString('utf8')));resources.push({path:resolved.absolutePath,sha256:sha(content),bytes:content.length});attributions.push(resolved.entry);options.signal?.throwIfAborted();
  }
  if(snapshot.legacyLookId){const look=findLookPreset(snapshot.legacyLookId);attributions.push({id:look.id,license:look.license,provenance:look.provenance});}
  const grade=resolveColorGradeV2(snapshot.gradeV2??{schema:'editkin.color-grade/v2'},'rec709_display',ref=>{const cube=cubes.get(ref.sha256);if(!cube)throw Error('RGB8 調色素材已變更。');return cube;});
  const created:Array<{path:string;sha256:string}>=[];let lutPath:string|undefined;
  if(!grade.identity){const text=ffmpegRenderCubeText(bakeResolvedGradeLut(grade),'Editkin RGB8 full grade v2',false);if(Buffer.byteLength(text)>16*1024*1024)throw Error('RGB8 調色素材超過容量上限。');lutPath=join(options.jobRoot,'grade.cube');const file=await open(lutPath,'wx',0o600);try{const identity=await file.stat(),owner={path:lutPath,dev:identity.dev,ino:identity.ino};options.onOwnedFile?.(owner);await file.writeFile(text);await file.sync();const sha256=sha(text);created.push({path:lutPath,sha256});options.onOwnedFile?.({...owner,sha256});}finally{await file.close();}}
  const minimal=createEmptyProject('Editkin RGB8 grade map',{width:options.size,height:options.size,fps:30}),duration=options.planeCount/30;
  minimal.colorManagement={...snapshot.management};minimal.assets.push({id:'rgb8-map',name:'Decoded normalized RGB8 map',uri:'owned-rgb8-pipe',kind:'video',duration,width:options.size,height:options.size,alphaMode:'opaque',color:{interpretation:'rec709'}});
  const track=minimal.tracks[0];track.clips.push({id:'rgb8-grade',trackId:track.id,assetId:'rgb8-map',timelineStart:0,sourceStart:0,duration,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...snapshot.color},keyframes:[],creative:{lookPresetId:snapshot.legacyLookId,effectPresetIds:[]},...(snapshot.gradeV2?{gradeV2:structuredClone(snapshot.gradeV2)}:{})});
  const clip=track.clips[0],asset=minimal.assets[0],probe={hasVideo:true,hasAudio:false,duration,width:options.size,height:options.size,colorPrimaries:'bt709',colorTransfer:'bt709',colorMatrix:'gbr',colorRange:'pc',pixelFormat:'rgb24'};
  // A cube cannot include spatial finishing; only the pointwise stage is passed to the same unchanged compositor.
  const chains=compositorVideoFilters({clip,asset,assetPath:'owned-rgb8-pipe',probe,inputIndex:0,alphaPlan:compileClipAlphaPlan(minimal,clip,'formal')},'rgb8stage',buildRenderPlan(minimal,uri=>uri),minimal,undefined,false,{space:'rec709_display',...(lutPath?{lutPath}:{})});
  return{snapshot,snapshotSha256:sha(JSON.stringify(snapshot)),created,resources,attributions,omittedSpatial:Object.keys(grade.finishing??{}),graph:[...chains,'[rgb8stage]format=rgb24[rgb8out]'].join(';'),inputBasis:'after-source-decode-and-normalization-opaque-RGB8' as const,sourceMovieMeasured:false as const,originalFloatCaseComplete:false as const};
}
