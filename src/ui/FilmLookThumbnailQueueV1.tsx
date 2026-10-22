import {createContext,useContext,useEffect,useRef,useState,useMemo,type ReactNode} from 'react';
import type {ColorAdjustments,ColorGradeLutRefV2,ColorGradeV2,ColorManagementSettings,MediaAsset} from '../domain/types';
import {LOOK_THUMBNAIL_LIMITS_V1,lookThumbnailRecipeV1,lookThumbnailRequestKeyV1,lookThumbnailAssetV1,type LookThumbnailFrameV1} from '../color/lookThumbnailSpecV1';
import {previewFramePipelineKeyV1,samePreviewFrameV1,type PreviewFrameIdentityV1} from '../color/previewPixelPickerV1';
import GradedMedia from './GradedMedia';
import {translateUi as uiText,useI18n} from './i18n/interfacePreferences';
import './filmLookThumbnailV1.css';
import {lookThumbnailRenderLeaseV1} from './lookThumbnailRenderLeaseV1';
type Result={uri?:string;state:'waiting'|'rendering'|'ready'|'error'};
const Results=createContext<Record<string,Result>>({});
interface Props {frame?:LookThumbnailFrameV1;asset:MediaAsset;color:ColorAdjustments;grade?:ColorGradeV2;management:ColorManagementSettings;rec709Input?:'display'|'camera';ids:readonly string[];strength:number;active:boolean;readLut?:(ref:ColorGradeLutRefV2)=>Promise<string>;children:ReactNode;unavailable?:string}
function ThumbnailJob({props,id,jobKey,onDone,onClosed}:{props:Props;id:string;jobKey:string;onDone:(uri?:string)=>void;onClosed:()=>void}){
  const root=useRef<HTMLDivElement>(null),done=useRef(false),frame=props.frame!,asset=props.asset,grade=useMemo(()=>lookThumbnailRecipeV1(props.grade,id,props.strength),[props,id]),expected:PreviewFrameIdentityV1={pipelineKey:previewFramePipelineKeyV1({asset,source:frame.uri,grade,management:props.management,rec709Input:props.rec709Input,ownerKey:jobKey}),primaryKey:JSON.stringify(props.color)};
  const finish=(uri?:string)=>{if(done.current)return;done.current=true;onDone(uri);};
  useEffect(()=>{const canvas=root.current?.querySelector<HTMLCanvasElement>('canvas[data-grade-status]');const watch=()=>{if(canvas?.dataset.gradeStatus==='error')finish();};const observer=new MutationObserver(watch);if(canvas)observer.observe(canvas,{attributes:true,attributeFilter:['data-grade-status']});const timer=setTimeout(()=>finish(),LOOK_THUMBNAIL_LIMITS_V1.timeoutMs);watch();return()=>{done.current=true;observer.disconnect();clearTimeout(timer);};},[]);
  return <div ref={root} className="look-thumbnail-renderer" data-testid="look-thumbnail-renderer" data-look-render-id={id}><GradedMedia asset={asset} source={frame.uri} color={props.color} grade={grade} management={props.management} rec709Input={props.rec709Input} readLut={props.readLut} testId="preview-image" frameOwnerKey={jobKey}
    onPipelineClosed={onClosed} onFrame={(canvas,_source,identity)=>{if(done.current||!samePreviewFrameV1(identity,expected)||canvas.width!==frame.width||canvas.height!==frame.height)return;try{const uri=canvas.toDataURL('image/png');if(!uri.startsWith('data:image/png;base64,')||uri.length>LOOK_THUMBNAIL_LIMITS_V1.resultUriBytes)throw Error('Look 縮圖超過容量上限。');finish(uri);}catch{finish();}}}/></div>;
}
export function FilmLookThumbnailQueueV1(props:Props){
  const key=lookThumbnailRequestKeyV1(props.frame,props.color,props.grade,props.management,props.rec709Input,props.ids,props.strength),[stored,setStored]=useState<{key:string;results:Record<string,Result>}>(),current=useRef({key,active:props.active});current.current={key,active:props.active};
  const [job,setJob]=useState<{token:object;key:string;id:string;props:Props}>(),[leaseEpoch,setLeaseEpoch]=useState(0);
  const results=props.active&&stored?.key===key?stored.results:{},next=props.active&&props.frame?props.ids.find(id=>!results[id]):undefined;
  const settle=(id:string,captured:string,uri?:string)=>{setJob(old=>old?.key===captured?undefined:old);if(current.current.key!==captured||!current.current.active)return;setStored(old=>({key:captured,results:{...(old?.key===captured?old.results:{}),[id]:{uri,state:uri?'ready':'error'}}}));};
  useEffect(()=>{if(!props.active)setStored(undefined);},[props.active]);
  useEffect(()=>lookThumbnailRenderLeaseV1.subscribe(()=>setLeaseEpoch(v=>v+1)),[]);
  useEffect(()=>{if(job&&(job.key!==key||!props.active)){setJob(undefined);return;}if(job||!next||!props.frame)return;const token=lookThumbnailRenderLeaseV1.acquire();if(token)setJob({token,key,id:next,props:{...props,asset:lookThumbnailAssetV1(props.asset,props.frame),color:{...props.color},grade:props.grade?structuredClone(props.grade):undefined,management:{...props.management},frame:{...props.frame},ids:[...props.ids]}});},[key,next,props.active,job,leaseEpoch]);
  return <Results.Provider value={results}>{props.children}{job&&job.key===key&&props.active&&<ThumbnailJob key={job.key+':'+job.id} props={job.props} id={job.id} jobKey={job.key+':'+job.id} onDone={uri=>settle(job.id,job.key,uri)} onClosed={()=>lookThumbnailRenderLeaseV1.release(job.token)}/>}<small data-testid="look-thumbnails-status">{uiText(props.unavailable??(!props.frame?'Look 縮圖等待目前影格…':next?'正在更新風格縮圖…':'縮圖是目前影格的風格預覽。'))}</small></Results.Provider>;
}
export function FilmLookThumbnailV1({id,name}:{id:string;name:string}){useI18n();const result=useContext(Results)[id];return <span className="film-look-thumbnail" data-testid={`look-thumbnail-${id}`} data-look-thumbnail-status={result?.state??'waiting'}>{result?.uri?<img src={result.uri} width="192" height="108" alt={uiText('{value0} · 目前影格 Look 縮圖',{value0:name})}/>:<span aria-hidden>{uiText(result?.state==='error'?'縮圖無法渲染':'等待縮圖')}</span>}</span>;}
