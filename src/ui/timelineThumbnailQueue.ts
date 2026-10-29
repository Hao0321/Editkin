export interface TimelineThumbnailSource { id: string; uri: string }
interface Dependencies {
  generate: (uri: string, signal: AbortSignal) => Promise<string>;
  publish: (source: TimelineThumbnailSource, thumbnail: string) => void;
  revoke: (thumbnail: string) => void;
}
/** One decoder at a time. Every result belongs to this source generation and is revoked by its owner. */
export function createTimelineThumbnailQueue(sources: readonly TimelineThumbnailSource[], dependencies: Dependencies) {
  const abort = new AbortController(), owned = new Set<string>();
  const done = (async () => {
    for (const source of sources) {
      await new Promise<void>(resolve => setTimeout(resolve,0));
      if (abort.signal.aborted) break;
      let thumbnail: string;
      try { thumbnail = await dependencies.generate(source.uri,abort.signal); } catch { continue; }
      if (abort.signal.aborted) { dependencies.revoke(thumbnail); break; }
      owned.add(thumbnail); dependencies.publish(source,thumbnail);
    }
  })();
  return { done, cancel() { abort.abort(); for (const uri of owned) dependencies.revoke(uri); owned.clear(); } };
}

/** A real first decoded frame. The temporary video is never attached to, or used by, playback. */
export async function generateTimelineThumbnail(uri: string, signal: AbortSignal): Promise<string> {
  const video=document.createElement("video"); video.muted=true; video.preload="auto"; video.crossOrigin="anonymous";
  try {
    await new Promise<void>((resolve,reject)=>{
      const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener("abort",cancel);video.removeEventListener("loadeddata",ready);video.removeEventListener("error",failed);error?reject(error):resolve();};
      const ready=()=>finish(),failed=()=>finish(new Error("thumbnail decode failed")),cancel=()=>finish(new DOMException("Cancelled","AbortError"));
      const timer=setTimeout(failed,15000);
      video.addEventListener("loadeddata",ready,{once:true});video.addEventListener("error",failed,{once:true});signal.addEventListener("abort",cancel,{once:true});
      if(signal.aborted){cancel();return;}video.src=uri;video.load();
    });
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    if(!video.videoWidth||!video.videoHeight)throw new Error("thumbnail has no decoded frame");
    const canvas=document.createElement("canvas"),scale=Math.min(160/video.videoWidth,160/video.videoHeight);
    canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
    const context=canvas.getContext("2d");if(!context)throw new Error("thumbnail canvas unavailable");context.drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("thumbnail encoding failed")),"image/png"));
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    return URL.createObjectURL(blob);
  } finally { video.pause();video.removeAttribute("src");video.load(); }
}
