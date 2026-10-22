import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ColorCurvePointV2 } from "../domain/visualTypes";
import { addCurvePointV1, identityCurveV1, moveCurvePointV1 } from "../domain/colorGradePanelEditsV1";
import { buildMonotoneCurve, evaluateMonotoneCurve } from "../color/gradeV2Color";
import { translateUi as uiText } from "./i18n/interfacePreferences";
interface Props { points?: ColorCurvePointV2[]; channel: string; disabled: boolean; onDraft: (points: ColorCurvePointV2[]) => void; onCommit: () => void; onCancel: () => void; onAction: (points: ColorCurvePointV2[]) => void }
export function ColorGradeCurveV1({ points: authored, channel, disabled, onDraft, onCommit, onCancel, onAction }: Props) {
  type Held = {pointerId?:number;target?:SVGSVGElement;index:number;points:ColorCurvePointV2[]};
  const points = authored ?? identityCurveV1(), held=useRef<Held|undefined>(undefined), mounted=useRef(true), [selected,setSelected]=useState(0);
  const latest=useRef({onDraft,onCommit,onCancel});latest.current={onDraft,onCommit,onCancel};
  const finish=(commit:boolean)=>{
    const input=held.current;held.current=undefined;if(!input)return;
    try {if(commit)latest.current.onCommit();else latest.current.onCancel();}
    finally {try {if(input.pointerId!==undefined&&input.target?.hasPointerCapture(input.pointerId))input.target.releasePointerCapture(input.pointerId);}catch{/* detached capture */}}
  };
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;finish(false);};},[]);
  const curve = buildMonotoneCurve(points.map(p => p.x), points.map(p => p.y));
  const path = Array.from({ length: 129 }, (_, i) => { const x = i / 128; return `${i ? "L" : "M"}${15 + x * 210},${225 - evaluateMonotoneCurve(curve, x) * 210}`; }).join(" ");
  const index = Math.min(selected, points.length - 1);
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const input=held.current;if(!mounted.current||disabled||!input||input.pointerId!==event.pointerId)return;
    const box=event.currentTarget.getBoundingClientRect();if(box.width<=0||box.height<=0)return;
    input.points=moveCurvePointV1(input.points,input.index,((event.clientX-box.left)/box.width*240-15)/210,(225-(event.clientY-box.top)/box.height*240)/210);
    latest.current.onDraft(input.points);
  };
  return <div className="grade-node-curve">
    <svg viewBox="0 0 240 240" className="grade-curve-plot" data-testid="grade-node-curve" aria-label={uiText("{value0} 曲線", { value0: channel })}
      onPointerMove={move} onPointerUp={event=>{if(held.current?.pointerId===event.pointerId)finish(true);}}
      onPointerCancel={event=>{if(held.current?.pointerId===event.pointerId)finish(false);}}
      onLostPointerCapture={event=>{if(held.current?.pointerId===event.pointerId)finish(false);}}>
      {[0, .25, .5, .75, 1].map(t => <path key={t} className="grade-curve-grid" d={`M15,${225 - t * 210}H225 M${15 + t * 210},15V225`} />)}
      <path className="grade-curve-diagonal" d="M15,225L225,15" /><path className={`grade-curve-line channel-${channel}`} d={path} />
      {points.map((p, i) => <circle key={i} cx={15 + p.x * 210} cy={225 - p.y * 210} r={i === index ? 6 : 4.5} className="grade-curve-point" tabIndex={disabled ? -1 : 0} role="button"
        aria-label={uiText("曲線控制點 {value0}", { value0: i + 1 })} aria-disabled={disabled} data-testid={`grade-curve-point-${i}`}
        onPointerDown={event=>{
          if(!mounted.current||disabled||event.button!==0||event.isPrimary===false||held.current)return;
          const target=event.currentTarget.ownerSVGElement;if(!target)return;
          setSelected(i);held.current={pointerId:event.pointerId,target,index:i,points:points.map(p=>({...p}))};
          try{target.setPointerCapture(event.pointerId);}catch{finish(false);}
        }}
        onFocus={()=>setSelected(i)}
        onKeyDown={event=>{
          if(!mounted.current||disabled||event.nativeEvent?.isComposing||event.nativeEvent?.keyCode===229)return;
          if(event.key==="Escape"){event.preventDefault();event.stopPropagation();finish(false);return;}
          if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)||held.current?.pointerId!==undefined)return;
          event.preventDefault();
          const input=held.current??(held.current={index:i,points:points.map(p=>({...p}))});if(input.index!==i)return;
          const current=input.points[i],step=event.shiftKey ? .05 : .01;
          input.points=moveCurvePointV1(input.points,i,current.x+(event.key==="ArrowLeft"?-step:event.key==="ArrowRight"?step:0),current.y+(event.key==="ArrowUp"?step:event.key==="ArrowDown"?-step:0));
          latest.current.onDraft(input.points);
        }}
        onKeyUp={event=>{if(!event.nativeEvent?.isComposing&&event.nativeEvent?.keyCode!==229&&event.key.startsWith("Arrow")&&held.current?.pointerId===undefined)finish(true);}}
        onBlur={()=>finish(held.current?.pointerId===undefined)} />)}
      <text x="15" y="238">0</text><text x="217" y="238">1</text>
    </svg>
    <div className="grade-v2-actions"><button type="button" disabled={disabled || points.length >= 16} onClick={() => {finish(false);onAction(addCurvePointV1(points));}}>{uiText("新增曲線點")}</button>
      <button type="button" disabled={disabled || points.length <= 2 || index === 0 || index === points.length - 1} onClick={() => {finish(false);onAction(points.filter((_, i) => i !== index));}}>{uiText("移除曲線點")}</button></div>
    <small>{uiText("控制點 {value0}：輸入 {value1}，輸出 {value2}", { value0: index + 1, value1: points[index].x.toFixed(3), value2: points[index].y.toFixed(3) })}</small>
  </div>;
}
