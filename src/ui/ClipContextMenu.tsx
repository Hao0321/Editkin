import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { trackMenuPosition } from "./trackMenuPosition";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";

export interface ClipMenuTarget {clipId:string;x:number;y:number}
/** The actions a clip menu can offer; the menu exists only when there is one. An empty role="menu" would still own the
 * keyboard (useEditorShortcuts treats an open menu as the key owner) until a click, a scroll or Esc dismissed it. */
export interface ClipMenuActions {onFreezeFrame?:unknown;onDetachAudio?:unknown;onLink?:unknown;onUnlink?:unknown}
export function clipMenuHasActions(actions:ClipMenuActions):boolean{return Boolean(actions.onFreezeFrame||actions.onDetachAudio||actions.onLink||actions.onUnlink);}
export function ClipContextMenu({target,disabled,onClose,onFreezeFrame,onDetachAudio,onLink,onUnlink}:{target:ClipMenuTarget;disabled:boolean;onClose:()=>void;onFreezeFrame?:(clipId:string)=>unknown;onDetachAudio?:(clipId:string)=>unknown;onLink?:()=>unknown;onUnlink?:()=>unknown}) {
  useI18n();const menu=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss=(event:Event)=>{if(!menu.current?.contains(event.target as Node)) onClose();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}};
    document.addEventListener('pointerdown',dismiss,true);document.addEventListener('scroll',dismiss,true);window.addEventListener('resize',dismiss);
    document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('scroll',dismiss,true);window.removeEventListener('resize',dismiss);document.removeEventListener('keydown',key,true);};
  },[onClose]);
  const position=trackMenuPosition({left:target.x,top:target.y,bottom:target.y},window.innerWidth,window.innerHeight);
  if(!clipMenuHasActions({onFreezeFrame,onDetachAudio,onLink,onUnlink})) return null;
  return createPortal(<div ref={menu} role="menu" className="track-options-menu" aria-label={uiText("片段操作")} style={position} data-testid="clip-context-menu">
    {onFreezeFrame && <button type="button" role="menuitem" disabled={disabled} onClick={()=>{onClose();onFreezeFrame(target.clipId);}} data-testid="clip-context-freeze">{uiText("定格 2 秒")}</button>}
    {onDetachAudio && <button type="button" role="menuitem" disabled={disabled} onClick={()=>{onClose();onDetachAudio(target.clipId);}} data-testid="clip-context-detach">{uiText("分離聲音")}</button>}
    {onLink && <button type="button" role="menuitem" disabled={disabled} onClick={()=>{onClose();onLink();}} data-testid="clip-context-link">{uiText("連結")}</button>}
    {onUnlink && <button type="button" role="menuitem" disabled={disabled} onClick={()=>{onClose();onUnlink();}} data-testid="clip-context-unlink">{uiText("取消連結")}</button>}
  </div>,document.body);
}
