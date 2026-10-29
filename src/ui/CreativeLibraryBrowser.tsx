import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import {useCallback,useDeferredValue,useEffect,useMemo,useRef,useState} from "react";
import type {CreativeLibrarySummary} from "../application/creativeLibrary";
import CreativePreviewTile from "./CreativePreviewTile";
import {createAnimationFrameScrollCommit,handleLibraryViewportWheel,libraryAssetKind,libraryWindow,type LibraryKind,type PreviewResolver} from "./creativeLibraryPreview";
import "./creativeLibraryBrowser.css";
import "./creativeLibraryFilters.css";
type BrowserKind = LibraryKind | "original_sfx";
interface Props {onLoadOriginalSfxCandidates?: () => Promise<void>;library?:CreativeLibrarySummary;loading?:boolean;importingId?:string;previewingId?:string;onImport?:(id:string)=>void;onAudioPreview?:(id:string)=>void;onResolvePreview?:PreviewResolver;onAutoMusic?:()=>void;}
const kinds:Array<[BrowserKind,string]>=[["all","全部"],["broll","補充畫面"],["transition","轉場"],["motion","動態素材"],["private_animation","私人動畫"],["audio","音訊"],["image","圖片"],["original_sfx","原創音效（待試聽）"]];
export const CREATIVE_LIBRARY_ROW_HEIGHT=132;
export default function CreativeLibraryBrowser({library,loading,importingId,previewingId,onImport,onAudioPreview,onResolvePreview,onAutoMusic,onLoadOriginalSfxCandidates}:Props) {
  useI18n();
  const scroll=useRef<HTMLDivElement>(null),[query,setQuery]=useState(""),[kind,setKind]=useState<BrowserKind>("all"),[scrollTop,setScrollTop]=useState(0),[activeId,setActiveId]=useState<string>();
  const [viewportHeight,setViewportHeight]=useState(600);
  const search=useDeferredValue(query.trim().toLocaleLowerCase());
  const activate=useCallback((id:string)=>setActiveId(id),[]);
  const deactivate=useCallback((id:string)=>setActiveId(current=>current===id?undefined:current),[]);
  const filtered=useMemo(()=>(library?.assets??[]).filter(asset=>(kind==="original_sfx"?asset.category==="original-sfx-candidate":kind==="all"||libraryAssetKind(asset)===kind)&&(!search||`${asset.name} ${asset.sourceFilename??""} ${asset.role} ${asset.category} ${asset.domains.join(" ")}`.toLocaleLowerCase().includes(search))),[library,kind,search]);
  const windowed=libraryWindow(filtered,scrollTop,viewportHeight,CREATIVE_LIBRARY_ROW_HEIGHT),revision=`${library?.id??""}:${library?.version??""}`;
  useEffect(()=>{setScrollTop(0);setActiveId(undefined);if(scroll.current)scroll.current.scrollTop=0;},[kind,search,revision]);
  useEffect(()=>{const node=scroll.current;if(!node)return;const measure=()=>setViewportHeight(height=>height===node.clientHeight?height:node.clientHeight);measure();if(!("ResizeObserver" in window))return;const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const node=scroll.current;if(!node)return;
    const frameCommit=createAnimationFrameScrollCommit(
      next=>setScrollTop(current=>current===next?current:next),
      callback=>requestAnimationFrame(callback),
      handle=>cancelAnimationFrame(handle),
    );
    const onScroll=()=>frameCommit.push(node.scrollTop);
    const onWheel=(event:globalThis.WheelEvent)=>{
      if(!handleLibraryViewportWheel(node,event))return;
      // The packaged WebView receipt observed a trusted wheel and a real
      // scroll range, but Chromium's default action left this viewport at 0.
      // Own that action on the actual scroll node so its hit child and the
      // compositor's default-scroll path cannot strand the virtual window.
      frameCommit.push(node.scrollTop);
    };
    node.addEventListener("scroll",onScroll,{passive:true});
    node.addEventListener("wheel",onWheel,{passive:false});
    return()=>{node.removeEventListener("scroll",onScroll);node.removeEventListener("wheel",onWheel);frameCommit.dispose();};
  },[]);
  return <div
    className="creative-library visual-library"
    data-testid="creative-library"
    data-library-count={filtered.length}
    data-library-total={library?.assetCount??0}
    data-library-loading={loading?"true":"false"}
  >
    <div className="library-heading"><span><strong>{uiText("內建素材")}</strong><small>{loading ? uiText("載入中") : uiText("{value0} 項", { value0: filtered.length })}</small></span>{onAutoMusic&&Boolean(library?.musicAssetCount) ? <button type="button" className="auto-music-button compact" onClick={onAutoMusic}>{uiText("♫ 智慧配樂")}</button> : null}</div>
    <div className="library-filter-row"><select className="library-kind-select" aria-label={uiText("素材類型")} value={kind} onChange={event=>{const next=event.target.value as BrowserKind;setKind(next);if(next==="original_sfx")void onLoadOriginalSfxCandidates?.();}}>{kinds.filter(([id])=>id!=="original_sfx"||Boolean(onLoadOriginalSfxCandidates)).map(([id,label])=><option key={id} value={id}>{id==="original_sfx"?uiText(label):label}</option>)}</select>
    <input className="library-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={uiText("搜尋素材…")} aria-label={uiText("搜尋素材")}/></div>
    {kind==="original_sfx" ? <small role="status">{uiText("這些音效由本機原創合成，尚待試聽確認；不會自動套用。")}</small> : null}
    <div className="visual-library-grid" ref={scroll} data-testid="creative-library-scroll" data-wheel-scroll="vertical" tabIndex={0} aria-label={uiText("{value0} 項素材，可持續捲動", { value0: filtered.length })}>
      {windowed.before>0 ? <div aria-hidden="true" className="library-spacer" style={{height:windowed.before}}/> : null}
      {loading ? <small>{uiText("正在讀取素材清單…")}</small> : !filtered.length ? <small>{uiText("沒有符合的素材")}</small> : windowed.items.map(asset=><article key={`${revision}:${asset.id}`} className="creative-asset-card" draggable={false} style={{height:CREATIVE_LIBRARY_ROW_HEIGHT-10}} title={uiText("{value0} · {value1} · {value2}；先按加入取得真素材，再從專案素材拖曳", { value0: String(asset.name), value1: String(asset.provenance), value2: String(asset.license) })}>
        <CreativePreviewTile asset={asset} revision={revision} active={activeId===asset.id} playing={previewingId===asset.id} resolve={onResolvePreview} onActivate={activate} onDeactivate={deactivate} onAudioPreview={onAudioPreview}/>
        <div className="creative-asset-copy"><strong>{asset.name}</strong><small>{kinds.find(([id])=>id===libraryAssetKind(asset))?.[1]}{asset.suggestedUse?` · ${asset.suggestedUse}`:""}</small></div>
        <button type="button" className="library-add" disabled={!onImport||Boolean(importingId)} onClick={()=>onImport?.(asset.id)} aria-label={onImport?uiText("加入 {value0}", { value0: String(asset.name) }):uiText("{value0} 需由桌面版加入", { value0: String(asset.name) })}>{importingId===asset.id?uiText("加入中"):onImport?uiText("加入"):uiText("桌面加入")}</button>
      </article>)}
      {windowed.after>0 ? <div aria-hidden="true" className="library-spacer" style={{height:windowed.after}}/> : null}
    </div>
  </div>;
}
