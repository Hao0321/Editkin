/** Measurement-only overlay. Loaded only after the native integration-smoke opt-in. */
export function createPerformanceSeries(limit=200) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error("Invalid sample bound");
  const values:number[]=[];
  return {add(value:number){if(Number.isFinite(value)&&value>=0){values.push(value);if(values.length>limit)values.shift();}},reset(){values.length=0;},summary(){const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,max:sorted.length?sorted.at(-1)!:null};}};
}
export function installIntegrationUiPerformance(enabled:boolean):()=>void {
  if(enabled!==true||typeof document==="undefined")return ()=>{};
  if(document.getElementById("editkin-integration-performance"))return ()=>{};
  const input=createPerformanceSeries(),heartbeat=createPerformanceSeries(),posters=createPerformanceSeries();
  const box=document.createElement("aside"),text=document.createElement("pre"),reset=document.createElement("button");
  box.id="editkin-integration-performance";box.setAttribute("aria-label","Integration UI performance diagnostics");
  box.style.cssText="position:fixed;right:12px;bottom:42px;z-index:2147483646;background:#fff;color:#111;border:2px solid #333;padding:8px;font:12px/1.4 monospace;max-width:350px;pointer-events:auto";
  text.style.cssText="margin:0;white-space:pre-wrap;font:inherit";reset.textContent="Reset UI measurements";reset.style.cssText="font:inherit;min-height:32px";box.append(text,reset);document.body.append(box);
  const cards=new Map<Element,{visible:boolean;start?:number;recorded:boolean}>();
  let stopped=false,generation=0,lastFrame:number|undefined,frame=0,mountedMax=0,playingMax=0;
  const active=()=>document.visibilityState==="visible";
  const loaded=(card:Element)=>{const image=card.querySelector("img");return image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0;};
  const observe=new IntersectionObserver(entries=>{const now=performance.now();for(const entry of entries){const item=cards.get(entry.target);if(!item)continue;item.visible=entry.isIntersecting;if(!item.visible){item.start=undefined;continue;}if(active()&&!item.recorded&&item.start===undefined)item.start=now;}},{threshold:0.01});
  const scan=()=>{for(const card of document.querySelectorAll(".creative-asset-card")){if(card.querySelector(".creative-preview.audio"))continue;if(!cards.has(card)){cards.set(card,{visible:false,recorded:false});observe.observe(card);}}for(const [card]of cards){if(!card.isConnected){observe.unobserve(card);cards.delete(card);}}};
  const mutations=new MutationObserver(scan);mutations.observe(document.body,{childList:true,subtree:true});scan();
  const onInput=(event:Event)=>{if(!active()||box.contains(event.target as Node))return;const now=performance.now(),start=event.timeStamp>0&&event.timeStamp<=now?event.timeStamp:now,owner=generation;requestAnimationFrame(()=>{if(!stopped&&owner===generation&&active())input.add(performance.now()-start);});};
  for(const kind of ["wheel","keydown","pointerdown"])document.addEventListener(kind,onInput,{capture:true,passive:true});
  const onVisibility=()=>{lastFrame=undefined;generation++;for(const item of cards.values())item.start=undefined;};document.addEventListener("visibilitychange",onVisibility);
  const tick=(now:number)=>{if(stopped)return;if(active()){if(lastFrame!==undefined)heartbeat.add(now-lastFrame);lastFrame=now;for(const [card,item]of cards){if(!item.visible||item.recorded)continue;if(item.start===undefined)item.start=now;if(loaded(card)){posters.add(now-item.start);item.recorded=true;}}const videos=[...document.querySelectorAll<HTMLVideoElement>(".creative-preview video")];mountedMax=Math.max(mountedMax,videos.length);playingMax=Math.max(playingMax,videos.filter(v=>!v.paused&&!v.ended).length);}else lastFrame=undefined;frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
  const fmt=(series:ReturnType<typeof createPerformanceSeries>)=>{const s=series.summary();return s.n?`n=${s.n} p95=${s.p95!.toFixed(1)} max=${s.max!.toFixed(1)} ms`:"NOT_MEASURED n=0";};
  const readout=()=>{if(!active())return;const pending=[...cards.values()].filter(c=>c.visible&&!c.recorded&&c.start!==undefined);const wait=pending.length?Math.max(...pending.map(c=>performance.now()-c.start!)):0;const videos=[...document.querySelectorAll<HTMLVideoElement>(".creative-preview video")];text.textContent=`INTEGRATION ONLY · no quality verdict\nInput→rAF ${fmt(input)}\nHeartbeat ${fmt(heartbeat)}\nPoster visible→decoded ${fmt(posters)}\nPoster pending=${pending.length} longest=${wait.toFixed(0)}ms\nPoster minimum4: ${posters.summary().n>=4?"COLLECTED":"NOT_MEASURED"}\nVideo mounted=${videos.length} max=${mountedMax}\nVideo playing=${videos.filter(v=>!v.paused&&!v.ended).length} max=${playingMax}\nVisibility=${document.visibilityState}`;};
  reset.onclick=()=>{generation++;input.reset();heartbeat.reset();posters.reset();lastFrame=undefined;mountedMax=0;playingMax=0;for(const item of cards.values()){item.recorded=false;item.start=item.visible&&active()?performance.now():undefined;}readout();};
  readout();const interval=setInterval(readout,500);
  return ()=>{stopped=true;generation++;cancelAnimationFrame(frame);clearInterval(interval);observe.disconnect();mutations.disconnect();for(const kind of ["wheel","keydown","pointerdown"])document.removeEventListener(kind,onInput,true);document.removeEventListener("visibilitychange",onVisibility);cards.clear();box.remove();};
}
