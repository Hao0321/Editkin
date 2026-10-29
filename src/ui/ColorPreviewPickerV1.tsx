import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {createPreviewPickerControllerV1,type PreviewPickerStateV1} from './colorPreviewPickerControllerV1';
import type {PreviewFrameIdentityV1} from '../color/previewPixelPickerV1';
import {translateUi as uiText,useI18n} from './i18n/interfacePreferences';
import './colorPreviewPickerV1.css';
import{ColorEyedropperActionsV1,type ColorEyedropperConfigurationV1}from'./ColorEyedropperActionsV1';
export interface ColorPreviewPickerHandleV1 {receive:(canvas:HTMLCanvasElement,source:HTMLImageElement|HTMLVideoElement,identity:PreviewFrameIdentityV1)=>void;clear:()=>void;refresh:()=>void}
interface Props {getRoot:()=>HTMLElement|null;contextKey:string;expected:PreviewFrameIdentityV1;disabled?:boolean;actions?:ColorEyedropperConfigurationV1}
export const ColorPreviewPickerV1=forwardRef<ColorPreviewPickerHandleV1,Props>(function ColorPreviewPickerV1(props,ref){
  useI18n();const current=useRef(props);current.current=props;const [value,setValue]=useState<PreviewPickerStateV1>(),[side,setSide]=useState(1),controller=useRef<ReturnType<typeof createPreviewPickerControllerV1>|undefined>(undefined);
  if(!controller.current)controller.current=createPreviewPickerControllerV1(()=>current.current.getRoot(),setValue);const control=controller.current;control.setContext(props.contextKey,props.expected);
  useImperativeHandle(ref,()=>({receive:control.receive,clear:control.clear,refresh:control.refresh}),[control]);useEffect(()=>control.attach(),[control]);
  useEffect(()=>control.refresh(),[control,props.contextKey]);
  const state=value?.contextKey===props.contextKey?value:undefined,sample=state?.sample,armed=state?.armed&&!props.disabled;
  return <div className="color-preview-picker" data-testid="color-preview-picker" data-picker-armed={Boolean(armed)} data-picker-context={props.contextKey}>
    <div className="scope-toolbar"><button type="button" data-testid="color-picker-toggle" aria-pressed={Boolean(armed)} disabled={props.disabled||!state?.ready} onClick={()=>control.arm()}>{uiText('滴管取色')}</button>
      <label>{uiText('取樣範圍')}<select data-testid="color-picker-size" value={side} onChange={e=>{const next=Number(e.target.value);setSide(next);control.setSide(next);}}>{[1,3,5,9].map(n=><option key={n} value={n}>{n} × {n}</option>)}</select></label></div>
    <small>{uiText(armed?'點選影像取色；方向鍵移動，Enter 取樣，Esc 結束。':'讀取目前預覽的 SDR 8-bit 像素；取色不修改調色。')}</small>
    {sample&&<output data-testid="color-picker-result" data-picker-rgb={sample.rgb.join(',')} data-picker-x={sample.x} data-picker-y={sample.y} data-picker-basis={sample.basis}>
      <span className="color-picker-swatch" style={{backgroundColor:sample.hex}} aria-hidden/>{sample.hex} · RGB {sample.rgb.join(' / ')} · HSL {sample.hueDegrees===null?'—':sample.hueDegrees.toFixed(1)+'°'} / {(sample.saturation*100).toFixed(1)}% / {(sample.lightness*100).toFixed(1)}%
      <small>{uiText(sample.basis==='decoded-source-preview'?'原片預覽像素':'調色預覽像素')} · {sample.x}, {sample.y} · {sample.patchWidth} × {sample.patchHeight}</small>
    </output>}
    {props.actions&&<ColorEyedropperActionsV1 configuration={props.actions} readSample={()=>control.state()} disabled={props.disabled}/>}
    {state?.notice&&<small role="status">{uiText(state.notice)}</small>}
  </div>;
});
