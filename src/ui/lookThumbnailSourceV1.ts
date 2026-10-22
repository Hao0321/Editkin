import {lookThumbnailSizeV1,LOOK_THUMBNAIL_LIMITS_V1,type LookThumbnailFrameV1} from '../color/lookThumbnailSpecV1';
import {samePreviewFrameV1,type PreviewFrameIdentityV1} from '../color/previewPixelPickerV1';
export type LookThumbnailMediaV1=HTMLImageElement|HTMLVideoElement;
export function createLookThumbnailSourceV1(emit:(frame:LookThumbnailFrameV1|undefined)=>void){
  let key='',expected:PreviewFrameIdentityV1={pipelineKey:'',primaryKey:''},allowed=false,snapshot:LookThumbnailFrameV1|undefined,watched:LookThumbnailMediaV1|undefined;
  const events=['seeking','play','emptied','loadstart'],unwatch=()=>{for(const event of events)watched?.removeEventListener(event,clear);watched=undefined;};
  const clear=()=>{unwatch();if(snapshot){snapshot=undefined;emit(undefined);}};
  const readable=(media:LookThumbnailMediaV1,identity:PreviewFrameIdentityV1)=>media.tagName==='VIDEO'?(()=>{const v=media as HTMLVideoElement;return v.paused&&!v.seeking&&v.readyState>=2&&identity.sourceTime!==undefined&&Math.abs(v.currentTime-identity.sourceTime)<1e-4;})():(media as HTMLImageElement).complete&&(media as HTMLImageElement).naturalWidth>0;
  return{configure:(next:string,identity:PreviewFrameIdentityV1,enabled:boolean)=>{if(next!==key||!enabled){unwatch();snapshot=undefined;}key=next;expected=identity;allowed=enabled;},
    receive:(media:LookThumbnailMediaV1,identity:PreviewFrameIdentityV1)=>{
      if(!allowed||!samePreviewFrameV1(identity,expected))return;if(!readable(media,identity)){clear();return;}
      if(watched!==media){unwatch();watched=media;for(const event of events)media.addEventListener(event,clear);}if(snapshot?.contextKey===key)return;
      const width=media.tagName==='VIDEO'?(media as HTMLVideoElement).videoWidth:(media as HTMLImageElement).naturalWidth,height=media.tagName==='VIDEO'?(media as HTMLVideoElement).videoHeight:(media as HTMLImageElement).naturalHeight,size=lookThumbnailSizeV1(width,height),canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
      try{const ctx=canvas.getContext('2d');if(!ctx)throw Error('目前影格無法建立 Look 縮圖。');ctx.clearRect(0,0,size.width,size.height);ctx.drawImage(media,0,0,size.width,size.height);const uri=canvas.toDataURL('image/png');if(!uri.startsWith('data:image/png;base64,')||uri.length>LOOK_THUMBNAIL_LIMITS_V1.sourceUriBytes)throw Error('Look 縮圖來源超過容量上限。');snapshot={contextKey:key,uri,...size,sourceTime:identity.sourceTime,basis:'decoded-browser-source'};emit(snapshot);}catch{clear();emit(undefined);}finally{canvas.width=1;canvas.height=1;}
    },clear,previewUnavailable:(reason:'waiting'|'error')=>{if(reason==='error')clear();},dispose:()=>{unwatch();snapshot=undefined;},snapshot:()=>snapshot};
}
