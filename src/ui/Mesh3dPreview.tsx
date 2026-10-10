import { useEffect, useRef, useState } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import { mesh3dPreviewTime } from "../application/previewMedia";
import type { EditProject } from "../domain/types";
import { Mesh3dGeometryCache, parseMesh3dFont } from "../motion/mesh3dGeometry";
import { renderMesh3dFrame, type Mesh3dTexture } from "../motion/mesh3dRasterizer";
import { resolveBundledFontFace } from "../typography/fontFaces";

const fontLoads = new Map<number, Promise<ReturnType<typeof parseMesh3dFont>>>();
function fontAt(weight: number) {
  let pending = fontLoads.get(weight);
  if (!pending) {
    const file = resolveBundledFontFace("Noto Sans TC",weight)?.fontFile;
    if(!file)throw new Error(`3D 實體字缺少字重 ${weight} 的實際字型檔`);
    const load = window.haoDesktop?.isDesktop
      ? window.haoDesktop.readMesh3dFont ? window.haoDesktop.readMesh3dFont(weight).then(bytes=>new Uint8Array(bytes).buffer) : Promise.reject(new Error("桌面版尚未更新立體字載入介面"))
      : fetch(`./fonts/${file}`).then(response => { if(!response.ok)throw new Error(`3D 字型載入失敗：${weight}`);return response.arrayBuffer(); });
    pending = load.then(parseMesh3dFont);
    fontLoads.set(weight,pending);pending.catch(()=>fontLoads.delete(weight));
  }
  return pending;
}
export default function Mesh3dPreview(props:{project:EditProject;playhead:number;playing:boolean;layers:ActivePreviewLayer[]}) {
  const canvas=useRef<HTMLCanvasElement>(null), current=useRef(props), geometry=useRef<Mesh3dGeometryCache|undefined>(undefined);
  const media=useRef(new Map<string,HTMLVideoElement|HTMLImageElement>()), textureCanvas=useRef(document.createElement("canvas"));
  const mediaCallbacks=useRef(new Map<string,(node:HTMLVideoElement|HTMLImageElement|null)=>void>());
  const mediaRefFor=(id:string)=>{
    let callback=mediaCallbacks.current.get(id);
    if(!callback){callback=node=>{if(node)media.current.set(id,node);else{const previous=media.current.get(id);if(previous instanceof HTMLVideoElement)previous.pause();media.current.delete(id);}};mediaCallbacks.current.set(id,callback);}
    return callback;
  };
  const [error,setError]=useState(""), [ready,setReady]=useState(false); current.current=props;
  const scene=props.project.scene3d!;
  const fontKey=JSON.stringify([...new Set(scene.segments.flatMap(s=>s.objects.flatMap(o=>o.geometry.kind==="text"?[o.geometry.fontWeight]:[])))].sort());
  useEffect(()=>{
    let cancelled=false;setReady(false);setError("");
    void Promise.all((JSON.parse(fontKey) as number[]).map(async weight=>[weight,await fontAt(weight)] as const)).then(fonts=>{if(!cancelled){geometry.current=new Mesh3dGeometryCache(new Map(fonts));setReady(true);}}).catch(cause=>{if(!cancelled)setError(String(cause));});
    return()=>{cancelled=true;};
  },[fontKey]);
  useEffect(()=>{
    if(!ready||!canvas.current)return;
    let raf=0,disposed=false,lastKey="";const timings:number[]=[];
    function tick(){
      if(disposed)return;
      const {project,playhead,playing,layers}=current.current, scene=project.scene3d!, frameNumber=Math.min(Math.floor(playhead*project.fps),Math.round((scene.segments.at(-1)!.timelineStart+scene.segments.at(-1)!.duration)*project.fps)-1);
      const sampleTime=mesh3dPreviewTime(project,playhead);
      const segment=scene.segments.find(s=>sampleTime>=s.timelineStart&&sampleTime<s.timelineStart+s.duration)??scene.segments.at(-1)!;
      // UI history changes updatedAt immediately; file revision advances on save.
      const key=`${project.updatedAt}:${frameNumber}:${segment.id}:${Number(playing)}`;
      if(key===lastKey){raf=requestAnimationFrame(tick);return;}
      const textureIds=new Set(segment.objects.flatMap(o=>o.material.clipId?[o.material.clipId]:[]));
      const textures=new Map<string,Mesh3dTexture>(); let waiting=false;
      for(const id of textureIds){
        const layer=layers.find(l=>l.clip.id===id),node=media.current.get(id);
        if(!layer||!node){waiting=true;continue;}
        if(node instanceof HTMLVideoElement){
          const wanted=Math.max(0,Math.min(layer.asset.duration-1/project.fps,layer.clip.sourceStart+sampleTime-layer.clip.timelineStart));
          if(!Number.isFinite(node.duration)||node.readyState<2){waiting=true;continue;}
          if(playing){if(Math.abs(node.currentTime-wanted)>.15&&!node.seeking)node.currentTime=wanted;void node.play().catch(()=>undefined);}
          else{node.pause();if(Math.abs(node.currentTime-wanted)>1/project.fps/2&&!node.seeking)node.currentTime=wanted;}
          if(node.seeking){waiting=true;continue;}
        }else if(!node.complete||!node.naturalWidth){waiting=true;continue;}
        const width=node instanceof HTMLVideoElement?node.videoWidth:node.naturalWidth,height=node instanceof HTMLVideoElement?node.videoHeight:node.naturalHeight;
        const scale=Math.min(1,640/Math.max(width,height)), surface=textureCanvas.current;surface.width=Math.max(2,Math.round(width*scale));surface.height=Math.max(2,Math.round(height*scale));
        const context=surface.getContext("2d",{willReadFrequently:true})!;context.drawImage(node,0,0,surface.width,surface.height);
        textures.set(id,{width:surface.width,height:surface.height,rgba:context.getImageData(0,0,surface.width,surface.height).data});
      }
      if(!waiting){
        try{
          const width=project.height>=project.width?320:Math.round(320*project.width/project.height),height=Math.round(width*project.height/project.width),start=performance.now(),result=renderMesh3dFrame(scene,frameNumber/project.fps,width,height,geometry.current!,textures);
          const node=canvas.current!;node.width=width;node.height=height;node.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(result.rgba),width,height),0,0);
          const milliseconds=performance.now()-start;
          node.dataset.frame=String(frameNumber);node.dataset.triangles=String(result.triangleCount);node.dataset.renderMilliseconds=milliseconds.toFixed(2);
          if(lastKey){timings.push(milliseconds);if(timings.length>60)timings.shift();const sorted=timings.slice().sort((a,b)=>a-b);node.dataset.warmFrameCount=String(timings.length);node.dataset.warmP95Milliseconds=sorted[Math.floor((sorted.length-1)*.95)].toFixed(2);}lastKey=key;
          setError(previous=>previous?"":previous);
        }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
      }
      raf=requestAnimationFrame(tick);
    }
    raf=requestAnimationFrame(tick);return()=>{disposed=true;cancelAnimationFrame(raf);for(const node of media.current.values())if(node instanceof HTMLVideoElement)node.pause();};
  },[ready]);
  return <div style={{position:"absolute",inset:0}} data-testid="mesh-3d-preview" data-executor="shared-cpu-triangle-zbuffer/v1">
    <canvas ref={canvas} aria-label="網格 3D 場景預覽" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
    {props.layers.map(layer=>layer.asset.kind==="image"?<img key={layer.clip.id} src={layer.source} alt="" style={{display:"none"}} onError={()=>setError(`3D 材質 ${layer.asset.name} 無法讀取`)} ref={mediaRefFor(layer.clip.id)}/>:<video key={layer.clip.id} src={layer.source} muted preload="auto" playsInline style={{display:"none"}} onError={()=>setError(`3D 材質 ${layer.asset.name} 無法解碼`)} ref={mediaRefFor(layer.clip.id)}/>)}
    {(!ready||error)&&<div role={error?"alert":"status"} style={{position:"absolute",inset:0,background:"#FFFFFF",color:"#172033",padding:24}}>{error||"正在準備立體字型與場景…"}</div>}
  </div>;
}
