import {useEffect,useRef,useState} from "react";
import type {CreativeLibraryAsset} from "../application/creativeLibrary";
import {libraryPreviewCache,subscribeLibraryPreview,type PreviewResolver,type PreviewLease} from "./creativeLibraryPreview";
type Asset=CreativeLibraryAsset&{preview?:{poster:boolean;motion:boolean;revision:string}};
type BoundSource={url:string;resolver:PreviewResolver;id:string;revision:string;lease:PreviewLease};
export default function CreativePreviewTile({asset,revision,active,playing,resolve,onActivate,onDeactivate,onAudioPreview}:{asset:Asset;revision:string;active:boolean;playing:boolean;resolve?:PreviewResolver;onActivate:(id:string)=>void;onDeactivate:(id:string)=>void;onAudioPreview?:(id:string)=>void}) {
  const host=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null);
  const [visible,setVisible]=useState(false),[posterSource,setPoster]=useState<BoundSource>(),[mediaSource,setMedia]=useState<BoundSource>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  const identity=`${revision}:${asset.preview?.revision??"legacy"}`;
  const displayed=useRef({poster:posterSource,media:mediaSource,resolve,id:asset.id,identity});
  displayed.current={poster:posterSource,media:mediaSource,resolve,id:asset.id,identity};
  const failSource=(source:BoundSource|undefined,kind:"poster"|"media")=>{
    const current=displayed.current;
    if(!source||current[kind]!==source||source.resolver!==current.resolve||source.id!==current.id||source.revision!==current.identity)return;
    source.lease.invalidate();setFailed(true);
  };
  const currentUrl=(source:BoundSource|undefined)=>source?.resolver===resolve&&source?.id===asset.id&&source?.revision===identity?source.url:undefined;
  const poster=currentUrl(posterSource),media=currentUrl(mediaSource);
  const wantsVideo=visible&&active&&asset.mediaKind==="video"&&asset.preview?.motion!==false;
  const canResolvePoster=asset.mediaKind==="image"||asset.mediaKind==="video"&&asset.preview?.poster!==false;
  const posterMode=asset.mediaKind==="video"||asset.preview?.poster?"poster":"media";
  useEffect(()=>()=>onDeactivate(asset.id),[asset.id,onDeactivate]);
  useEffect(()=>{const node=host.current;if(!node)return;if(!("IntersectionObserver" in window)){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{root:node.closest(".visual-library-grid"),rootMargin:"0px"});observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible)onDeactivate(asset.id);},[visible,onDeactivate,asset.id]);
  // The browser already bounds the mounted window to eight cards. Resolve the
  // stable poster for that small window immediately instead of adding a second
  // visibility gate: virtual-list reorders can otherwise leave the new visible
  // cards blank while a smoke/readiness counter still sees decoded old cards.
  // IntersectionObserver remains responsible for the heavier motion preview.
  useEffect(()=>{setPoster(undefined);setFailed(false);if(resolve&&canResolvePoster){const lease=libraryPreviewCache.acquire(resolve,asset.id,identity,posterMode);return subscribeLibraryPreview(lease,url=>setPoster({url,resolver:resolve,id:asset.id,revision:identity,lease}),()=>setFailed(true));}},[resolve,asset.id,canResolvePoster,posterMode,identity,retry]);
  useEffect(()=>{setMedia(undefined);if(wantsVideo&&resolve){setFailed(false);const lease=libraryPreviewCache.acquire(resolve,asset.id,identity,"media");return subscribeLibraryPreview(lease,url=>setMedia({url,resolver:resolve,id:asset.id,revision:identity,lease}),()=>setFailed(true));}},[wantsVideo,resolve,asset.id,identity,retry]);
  useEffect(()=>{const node=video.current;if(!node||!media||!wantsVideo)return;let current=true;void node.play().catch(()=>{if(current)failSource(mediaSource,"media");});return()=>{current=false;node.pause();node.removeAttribute("src");node.load();};},[media,wantsVideo,mediaSource?.lease.generation]);
  const unavailable=asset.mediaKind!=="audio"&&!resolve;
  return <div ref={host} className={`creative-preview ${asset.mediaKind} ready`} aria-label={`${asset.name} 預覽`}>
    {wantsVideo&&media?<video key={mediaSource?.lease.generation} ref={video} src={media} muted loop playsInline preload="metadata" onError={()=>failSource(mediaSource,"media")}/>:poster?<img key={posterSource?.lease.generation} src={poster} alt={`${asset.name} 預覽`} loading="eager" decoding="async" onError={()=>failSource(posterSource,"poster")}/>:null}
    {asset.mediaKind==="audio"?<button type="button" className="audio-wave" onClick={()=>onAudioPreview?.(asset.id)} aria-label={`預聽 ${asset.name}`}><b>{playing?"■":"▶"}</b><span>{asset.bpm?`${Math.round(asset.bpm)} BPM`:"音訊"}</span></button>:null}
    {unavailable?<span className="preview-unavailable"><b>桌面版可顯示預覽</b><small>遠端模式仍可瀏覽素材資訊</small></span>:asset.mediaKind!=="audio"&&(failed||!poster&&!media)?<span className="preview-unavailable"><b>{failed?"預覽暫時無法載入":!canResolvePoster&&!wantsVideo?asset.preview?.motion===false?"這份素材未提供預覽":"點播放查看素材":"正在準備預覽"}</b>{failed?<button type="button" onClick={()=>setRetry(n=>n+1)}>重試</button>:null}</span>:null}
    {asset.mediaKind==="video"&&asset.preview?.motion!==false&&resolve?<button type="button" className="preview-toggle" onClick={()=>active?onDeactivate(asset.id):onActivate(asset.id)} aria-label={active?`停止 ${asset.name} 動態預覽`:`播放 ${asset.name} 動態預覽`}>{active?"■":"▶"}</button>:null}
  </div>;
}
