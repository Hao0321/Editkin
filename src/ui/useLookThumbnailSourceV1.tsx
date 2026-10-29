import {useEffect,useRef,useState} from 'react';
import {createLookThumbnailSourceV1,type LookThumbnailMediaV1} from './lookThumbnailSourceV1';
import type {LookThumbnailFrameV1} from '../color/lookThumbnailSpecV1';
import type {PreviewFrameIdentityV1} from '../color/previewPixelPickerV1';
export function useLookThumbnailSourceV1(contextKey:string,expected:PreviewFrameIdentityV1,allowed:boolean){
  const [value,setValue]=useState<LookThumbnailFrameV1>(),controller=useRef<ReturnType<typeof createLookThumbnailSourceV1>|undefined>(undefined);if(!controller.current)controller.current=createLookThumbnailSourceV1(setValue);const source=controller.current;source.configure(contextKey,expected,allowed);
  useEffect(()=>()=>source.dispose(),[source]);return{frame:allowed&&value?.contextKey===contextKey?value:undefined,receive:source.receive,clear:source.clear,previewUnavailable:source.previewUnavailable};
}
/** One decoder only when the existing scope renderer cannot supply a frame.
 * OCIO/ACES still runs in the unchanged thumbnail renderer; this is a paused
 * browser source snapshot, not a new formal HDR/scene-linear decode adapter. */
export function LookThumbnailFallbackSourceV1({source,kind,contextKey,identity,onFrame,onError}:{source:string;kind:'image'|'video';contextKey:string;identity:PreviewFrameIdentityV1;onFrame:(media:LookThumbnailMediaV1,identity:PreviewFrameIdentityV1)=>void;onError:()=>void}){
  const media=useRef<LookThumbnailMediaV1|null>(null),latest=useRef({onFrame,onError});latest.current={onFrame,onError};
  useEffect(()=>{const node=media.current;if(!node)return;let disposed=false;const receive=()=>{if(disposed)return;if(node.tagName==='VIDEO'){const v=node as HTMLVideoElement;if(v.readyState<1)return;const target=identity.sourceTime??0;if(Math.abs(v.currentTime-target)>1e-4){v.currentTime=target;return;}if(v.seeking||v.readyState<2)return;}latest.current.onFrame(node,{...identity,...(node.tagName==='VIDEO'?{sourceTime:(node as HTMLVideoElement).currentTime}:{})});};
    const failed=()=>{if(!disposed)latest.current.onError();};for(const event of ['loadedmetadata','loadeddata','seeked','load'])node.addEventListener(event,receive);node.addEventListener('error',failed);receive();return()=>{disposed=true;for(const event of ['loadedmetadata','loadeddata','seeked','load'])node.removeEventListener(event,receive);node.removeEventListener('error',failed);};
  },[contextKey,source,kind]);
  return kind==='video'?<video ref={node=>{media.current=node;}} src={source} preload="auto" muted playsInline aria-hidden className="look-thumbnail-source" data-testid="look-thumbnail-fallback-video"/>:<img ref={node=>{media.current=node;}} src={source} alt="" aria-hidden className="look-thumbnail-source" data-testid="look-thumbnail-fallback-image"/>;
}
