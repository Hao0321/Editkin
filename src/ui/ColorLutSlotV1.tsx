import { useEffect, useRef, useState } from "react";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import type { ColorLutDesktopEntryV1 } from "../domain/colorLutDesktopContractV1";
import type { ColorLutPickedV1 } from "../desktop/colorLutApiV1";
import { sameLutPanelContextV1, setNodeColorLutV1, type LutPanelContextV1 } from "../domain/colorLutPanelEditsV1";
import type { ColorLutClientV1 } from "../color/colorLutClientV1";
import { useGradeRangeInputV1 } from "./gradeRangeInputV1";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import "./colorLutSlotV1.css";
export interface ColorLutSlotPropsV1 extends LutPanelContextV1 {
  node:ColorGradeNodeV2;client?:ColorLutClientV1;editOccurrence?:unknown;
  onAction:(edit:(grade:ColorGradeV2|undefined)=>ColorGradeV2)=>unknown;
  onDraft:(edit:(node:ColorGradeNodeV2)=>ColorGradeNodeV2)=>void;onCommit:()=>void;onCancel:()=>void;
}
export function ColorLutSlotV1(props:ColorLutSlotPropsV1){
  const current=useRef(props);current.current=props;const mounted=useRef(false),epoch=useRef(0);
  const [entries,setEntries]=useState<ColorLutDesktopEntryV1[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[next,setNext]=useState<number>();
  const [selected,setSelected]=useState(props.node.lut?.id??''),[extra,setExtra]=useState<ColorLutDesktopEntryV1>();
  const [picked,setPicked]=useState<ColorLutPickedV1>(),[name,setName]=useState(''),[license,setLicense]=useState(''),[provenance,setProvenance]=useState(''),[rights,setRights]=useState(''),[inputSpace,setSpace]=useState(props.space);
  const [busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const begin=()=>({context:{...current.current},epoch:++epoch.current});
  const valid=(captured:ReturnType<typeof begin>,readonly=false)=>mounted.current&&captured.epoch===epoch.current&&captured.context.editOccurrence===current.current.editOccurrence&&sameLutPanelContextV1(captured.context,{...current.current,editable:readonly||current.current.editable,readOnly:readonly});
  const list=async(value=0)=>{const p=current.current;if(!p.client)return;const captured=begin();setBusy(true);try{const page=await p.client.list(value);if(valid(captured,true)){setEntries(page.entries);setTotal(page.total);setOffset(value);setNext(page.nextOffset);setStatus('');}}catch(e){if(valid(captured,true))setStatus(e instanceof Error?e.message:String(e));}finally{if(mounted.current&&captured.epoch===epoch.current)setBusy(false);}};
  useEffect(()=>{mounted.current=true;void list();return()=>{mounted.current=false;epoch.current++;};},[props.client]);
  const chosen=extra?.id===selected?extra:entries.find(e=>e.id===selected);
  const apply=async()=>{if(current.current!==props)return;const p=current.current;if(!p.client||!chosen||!p.editable)return;const entry=chosen,captured=begin();setBusy(true);
    try{if(entry.inputSpace!==p.space)throw new Error('LUT 色彩空間與目前專案不同，這次未套用。');await p.client.readCube({id:entry.id,sha256:entry.sha256,strength:1},p.space);
      if(valid(captured)){p.onAction(g=>setNodeColorLutV1(g,p.nodeId,entry,p.space));setStatus('已套用 LUT，可一次復原。');}}
    catch(e){if(valid(captured))setStatus(e instanceof Error?e.message:String(e));}finally{if(mounted.current&&captured.epoch===epoch.current)setBusy(false);}};
  const pick=async()=>{if(current.current!==props)return;const p=current.current;if(!p.client||!p.editable)return;const captured=begin();setBusy(true);try{const value=await p.client.pick();if(valid(captured)){setPicked(value??undefined);if(value)setName(value.suggestedName);setStatus('');}}catch(e){if(valid(captured))setStatus(e instanceof Error?e.message:String(e));}finally{if(mounted.current&&captured.epoch===epoch.current)setBusy(false);}};
  const importing=async()=>{if(current.current!==props)return;const p=current.current;if(!p.client||!picked||!p.editable)return;const captured=begin();setBusy(true);
    try{const result=await p.client.import({selectionId:picked.selectionId,name,license,provenance,rightsBasis:rights,inputSpace});if(valid(captured)){setPicked(undefined);setExtra(result.entry);setSelected(result.entry.id);setStatus('已匯入素材庫；按套用後才修改片段。');
        try{const page=await p.client.list(offset);if(valid(captured)){setEntries(page.entries);setTotal(page.total);setNext(page.nextOffset);}}catch{/* The confirmed import stays acknowledged even if the subsequent read fails. */}}}
    catch(e){if(valid(captured))setStatus(e instanceof Error?e.message:String(e));}finally{if(mounted.current&&captured.epoch===epoch.current)setBusy(false);}};
  const options=extra&&!entries.some(e=>e.id===extra.id)?[...entries,extra]:entries;
  const rangeInput=useGradeRangeInputV1([props.clipId,props.nodeId,props.editOccurrence,props.scope?.owner,props.scope?.sessionId,props.space,props.node.lut?.id,props.node.lut?.sha256]);
  return<div className="grade-v2-panel color-lut-slot" data-testid="color-lut-slot">
    <strong>{uiText('LUT 槽')}</strong><small>{uiText('LUT 在此節點內套用；僅接受已驗證且色彩空間相同的素材。')}</small>
    {!props.client?<small role="status">{uiText('這個版本尚未提供個人 LUT 素材庫 API。')}</small>:<>
      <label>{uiText('素材庫 LUT')}<select value={selected} disabled={busy||!props.editable} data-testid="lut-library-select" onChange={e=>{epoch.current++;setSelected(e.target.value);setStatus('');}}>
        <option value="">{uiText('選擇 LUT')}</option>{selected&&!options.some(e=>e.id===selected)&&<option value={selected}>{selected}</option>}
        {options.map(e=><option value={e.id} key={e.id}>{e.name} · {e.inputSpace}</option>)}</select></label>
      <small>{uiText('素材 {value0}–{value1}／{value2}',{value0:entries.length?offset+1:0,value1:offset+entries.length,value2:total})}</small>
      <div className="grade-v2-actions"><button type="button" disabled={busy||offset===0} onClick={()=>void list(Math.max(0,offset-100))}>{uiText('上一頁')}</button><button type="button" disabled={busy||next===undefined} onClick={()=>void list(next)}>{uiText('下一頁')}</button><button type="button" disabled={busy} onClick={()=>void list(offset)}>{uiText('重新載入')}</button></div>
      {chosen&&<small>{chosen.license} · {chosen.provenance} · {chosen.rightsBasis}</small>}
      <div className="grade-v2-actions"><button type="button" disabled={busy||!props.editable||!chosen} data-testid="lut-apply" onClick={()=>void apply()}>{uiText('套用 LUT')}</button><button type="button" disabled={busy||!props.editable||!props.node.lut} data-testid="lut-remove" onClick={()=>props.onAction(g=>setNodeColorLutV1(g,props.nodeId,undefined,props.space))}>{uiText('移除 LUT')}</button></div>
      <details><summary>{uiText('匯入自己的 .cube')}</summary><button type="button" disabled={busy||!props.editable} data-testid="lut-pick" onClick={()=>void pick()}>{uiText('選擇 .cube 檔案')}</button>
        {picked&&<><small>{picked.suggestedName}</small>{([[uiText('LUT 名稱'),name,setName,'lut-name'],[uiText('授權'),license,setLicense,'lut-license'],[uiText('來源'),provenance,setProvenance,'lut-provenance'],[uiText('使用權利依據'),rights,setRights,'lut-rights']] as const).map(([label,value,setter,id])=><label key={id}>{label}<input type="text" maxLength={200} value={value} disabled={busy} data-testid={id} onChange={e=>setter(e.target.value)}/></label>)}
          <label>{uiText('LUT 輸入色彩空間')}<select value={inputSpace} disabled={busy} data-testid="lut-import-space" onChange={e=>setSpace(e.target.value as typeof inputSpace)}><option value="rec709_display">Rec.709 display</option><option value="acescct">ACEScct</option></select></label>
          <button type="button" disabled={busy||!props.editable||![name,license,provenance,rights].every(v=>v.trim())} data-testid="lut-import" onClick={()=>void importing()}>{uiText('匯入素材庫')}</button><small>{uiText('請填入檔案實際的來源與授權；匯入不修改片段。')}</small></>}
      </details>
    </>}
    {props.node.lut&&<label><span>{uiText('LUT 強度')}<output>{props.node.lut.strength.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={props.node.lut.strength} disabled={busy||!props.editable} data-testid="lut-strength"
      {...rangeInput.bind('lut-strength',{disabled:busy||!props.editable,onBegin:props.onCancel,onDraft:value=>props.onDraft(n=>({...n,lut:n.lut?{...n.lut,strength:value}:undefined})),onCommit:props.onCommit,onCancel:props.onCancel})}/></label>}
    {status&&<small role="status">{uiText(status)}</small>}
  </div>;
}
