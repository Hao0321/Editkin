import { useEffect, useRef, useState } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import { addGradeNodeV1, beginGradePanelGestureV1, editGradeNodeV1, gradePanelKeyV1, moveGradeNodeV1, removeGradeNodeV1, sameGradePanelScopeV1, settleGradePanelGestureV1, type GradeCurveChannelV1, type GradePanelEditScopeV1, type GradePanelGestureV1, type GradeWheelKindV1 } from "../domain/colorGradePanelEditsV1";
import { ColorGradeWheelV1 } from "./ColorGradeWheelV1";
import { ColorQualifierControlsV1 } from "./ColorQualifierControlsV1";
import { ColorGradeCurveV1 } from "./ColorGradeCurveV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import "./gradeNodePanelV1.css";
import { ColorLutSlotV1 } from "./ColorLutSlotV1";
import { useGradeRangeInputV1 } from "./gradeRangeInputV1";
import type { ColorLutClientV1 } from "../color/colorLutClientV1";

interface Props { clipId: string; grade?: ColorGradeV2; onChange?: (grade: ColorGradeV2 | null) => void; onGestureStart?: () => ParameterGestureLeaseV1<ColorGradeV2> | undefined; readOnlyReason?: string; editScope?: GradePanelEditScopeV1; editOccurrence?: unknown; lutClient?:ColorLutClientV1; workingSpace?:"rec709_display"|"acescct" }
const WHEELS: GradeWheelKindV1[] = ["offset", "lift", "gamma", "gain"];
const NODE_CONTROLS = [{ key: "mix", label: "節點混合", min: 0, max: 1, default: 1 }, { key: "saturation", label: "節點飽和度", min: 0, max: 3, default: 1 }, { key: "contrast", label: "節點對比", min: 0, max: 3, default: 1 }] as const;
export function ColorGradeNodePanelV1(props: Props) {
  useI18n();
  const current = useRef(props); current.current = props;
  const gesture = useRef<GradePanelGestureV1 | undefined>(undefined);
  const gestureOccurrence = useRef(props.editOccurrence);
  // null means refused/retired: keep a tombstone until release, never fall back to onChange.
  const previewLease = useRef<ParameterGestureLeaseV1<ColorGradeV2> | null | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; previewLease.current?.cancel(); previewLease.current = undefined; gesture.current = undefined;
  }; }, []);
  const previousScope = useRef(props.editScope), scopeEpoch = useRef(0);
  if (!sameGradePanelScopeV1(previousScope.current, props.editScope)) { previousScope.current = props.editScope; scopeEpoch.current++; }
  const [draft, setDraft] = useState<GradePanelGestureV1>();
  const [selected, setSelected] = useState(props.grade?.nodes?.[0]?.id ?? "");
  const [channel, setChannel] = useState<GradeCurveChannelV1>("y");
  const [notice, setNotice] = useState("");
  const baseKey = gradePanelKeyV1(props.grade), editable = Boolean(props.onChange);
  const visible = draft?.clipId === props.clipId && draft.baseKey === baseKey && sameGradePanelScopeV1(draft.scope, props.editScope) && gestureOccurrence.current === props.editOccurrence && editable ? draft.draft : props.grade;
  const nodes = visible?.nodes ?? [], node = nodes.find(n => n.id === selected) ?? nodes[0], index = nodes.findIndex(n => n.id === node?.id);
  const rangeIdentity = [props.clipId, props.editOccurrence, props.editScope?.owner, props.editScope?.sessionId, node?.id];
  const rangeInput = useGradeRangeInputV1(rangeIdentity);
  const cancel = () => { previewLease.current?.cancel(); previewLease.current = undefined; gesture.current = undefined; if (mounted.current) setDraft(undefined); };
  const commit = () => {
    if (!mounted.current) return;
    const captured = gesture.current; if (!captured) return;
    const lease = previewLease.current;
    previewLease.current = undefined; gesture.current = undefined; setDraft(undefined);
    const latest = current.current;
    const next = gestureOccurrence.current === latest.editOccurrence ? settleGradePanelGestureV1(captured, latest.clipId, latest.grade, Boolean(latest.onChange), latest.editScope) : undefined;
    if (!next || lease === null) { lease?.cancel(); if (captured.clipId !== latest.clipId || captured.baseKey !== gradePanelKeyV1(latest.grade) || !sameGradePanelScopeV1(captured.scope, latest.editScope) || !latest.onChange) setNotice("片段或調色已更新，這次拖曳未套用。"); return; }
    if (lease) { if (!lease.commit()) setNotice("這次調色未套用，請重新選取節點再試。"); else setNotice(""); return; }
    try { latest.onChange?.(next); setNotice(""); } catch { setNotice("這次調色未套用，請重新選取節點再試。"); }
  };
  const changeDraft = (edit: (node: ColorGradeNodeV2) => ColorGradeNodeV2) => {
    if (!mounted.current || current.current !== props) return;
    const latest = current.current; if (!latest.onChange || !node) return;
    try {
      const old = gesture.current;
      if (old && (old.clipId !== latest.clipId || old.baseKey !== gradePanelKeyV1(latest.grade) || !sameGradePanelScopeV1(old.scope, latest.editScope) || gestureOccurrence.current !== latest.editOccurrence)) {
        // Keep the stale capture until release; later moves must not silently start a new transaction.
        setDraft(undefined); setNotice("片段或調色已更新，這次拖曳未套用。"); return;
      }
      const captured = old ?? beginGradePanelGestureV1(latest.clipId, latest.grade, latest.editScope);
      if (!old) {
        gestureOccurrence.current = latest.editOccurrence;
        previewLease.current = latest.onGestureStart ? latest.onGestureStart() ?? null : undefined;
        gesture.current = captured;
      }
      if (previewLease.current === null) return;
      const next = { ...captured, draft: editGradeNodeV1(captured.draft, node.id, edit) };
      if (previewLease.current && !previewLease.current.update(next.draft)) {
        previewLease.current.cancel(); previewLease.current = null; setDraft(undefined);
        setNotice("片段或調色已更新，這次拖曳未套用。"); return;
      }
      gesture.current = next; setDraft(next); setNotice("");
    } catch { cancel(); setNotice("這次調色未套用，請重新選取節點再試。"); }
  };
  const action = (edit: (grade: ColorGradeV2 | undefined) => ColorGradeV2) => {
    if (!mounted.current || current.current !== props) return;
    cancel(); const latest = current.current; if (!latest.onChange) return;
    try { const next = edit(latest.grade); if (gradePanelKeyV1(next) !== gradePanelKeyV1(latest.grade)) latest.onChange(next); setNotice(""); return next; }
    catch { setNotice("這次調色未套用，請重新選取節點再試。"); }
  };
  const qualifierEdit = (edit: (value: ColorGradeNodeV2) => ColorGradeNodeV2, draftOnly: boolean) => {
    if (!node || current.current !== props) { setNotice("片段或調色已更新，這次拖曳未套用。"); return; }
    if (draftOnly) changeDraft(edit); else action(g => editGradeNodeV1(g, node.id, edit));
  };
  return <details className="grade-v2-panel grade-node-panel" open data-testid="grade-node-panel">
    <summary>{uiText("調色節點、色輪與曲線")}</summary>
    <p>{uiText("拖曳時調整草稿，放開後套用；每次操作可復原一次。")}</p>
    {props.readOnlyReason && <small role="status">{uiText(props.readOnlyReason)}</small>}
    <div className="grade-node-list" role="group" aria-label={uiText("調色節點")}>
      {nodes.map((item, i) => <button type="button" key={item.id} className={item.id === node?.id ? "active" : ""} aria-pressed={item.id === node?.id}
        data-testid={`grade-node-select-${item.id}`} onClick={() => { cancel(); setSelected(item.id); }}>
        <span>{item.label || uiText("節點 {value0}", { value0: i + 1 })}</span><small>{item.id}{item.enabled === false ? ` · ${uiText("已略過")}` : ""}</small>
      </button>)}
    </div>
    <button type="button" className="grade-reset" disabled={!editable || nodes.length >= 4} data-testid="grade-node-add" onClick={() => { const next = action(addGradeNodeV1); if (next) setSelected(next.nodes!.at(-1)!.id); }}>{uiText("新增調色節點")}</button>
    {!node ? <small>{uiText("新增節點後，可調整色輪和曲線；不會改動既有 Look。")}</small> : <div key={`${props.clipId}:${scopeEpoch.current}:${node.id}`}>
      <div className="grade-node-actions">
        <button type="button" disabled={!editable} data-testid="grade-node-bypass" aria-pressed={node.enabled === false} onClick={() => action(g => editGradeNodeV1(g, node.id, n => ({ ...n, enabled: n.enabled === false })))}>{uiText(node.enabled === false ? "啟用節點" : "略過節點")}</button>
        <button type="button" disabled={!editable || index === 0} aria-label={uiText("節點上移")} onClick={() => action(g => moveGradeNodeV1(g, node.id, -1))}>↑</button>
        <button type="button" disabled={!editable || index === nodes.length - 1} aria-label={uiText("節點下移")} onClick={() => action(g => moveGradeNodeV1(g, node.id, 1))}>↓</button>
        <button type="button" disabled={!editable} data-testid="grade-node-remove" onClick={() => action(g => removeGradeNodeV1(g, node.id))}>{uiText("移除節點")}</button>
      </div>
      <div className="grade-control-grid">{NODE_CONTROLS.map(control => <label key={control.key}><span>{uiText(control.label)}<output>{(node[control.key] ?? control.default).toFixed(2)}</output></span>
        <input type="range" min={control.min} max={control.max} step="0.01" value={node[control.key] ?? control.default} disabled={!editable} aria-label={uiText(control.label)} data-testid={`grade-node-${control.key}`}
          {...rangeInput.bind(control.key, { disabled: !editable, onBegin: cancel, onDraft: value => changeDraft(n => ({ ...n, [control.key]: value })), onCommit: commit, onCancel: cancel })} /></label>)}</div>
      <div className="grade-node-wheels">{WHEELS.map(kind => <ColorGradeWheelV1 key={kind} kind={kind} wheel={node[kind]} disabled={!editable}
        onDraft={wheel => changeDraft(n => ({ ...n, [kind]: wheel }))} onCommit={commit} onCancel={cancel} />)}</div>
      <label className="grade-curve-channel">{uiText("曲線通道")}<select value={channel} onChange={event => { cancel(); setChannel(event.target.value as GradeCurveChannelV1); }} data-testid="grade-curve-channel">
        {(["y", "r", "g", "b"] as const).map(value => <option key={value} value={value}>{value === "y" ? "Y" : value.toUpperCase()}</option>)}</select></label>
      <ColorGradeCurveV1 key={channel} channel={channel.toUpperCase()} points={node.curves?.[channel]} disabled={!editable}
        onDraft={points => changeDraft(n => ({ ...n, curves: { ...n.curves, [channel]: points } }))} onCommit={commit} onCancel={cancel}
        onAction={points => action(g => editGradeNodeV1(g, node.id, n => ({ ...n, curves: { ...n.curves, [channel]: points } })))} />
      <ColorLutSlotV1 key={`${props.clipId}:${scopeEpoch.current}:${node.id}:${props.workingSpace??'rec709_display'}`} clipId={props.clipId} nodeId={node.id} grade={props.grade} node={node} editable={editable} scope={props.editScope} editOccurrence={props.editOccurrence} space={props.workingSpace??'rec709_display'} client={props.lutClient}
        onAction={action} onDraft={changeDraft} onCommit={commit} onCancel={cancel}/>
      <ColorQualifierControlsV1 node={node} disabled={!editable} editIdentity={rangeIdentity} onAction={edit => qualifierEdit(edit, false)}
        onDraft={edit => qualifierEdit(edit, true)} onCommit={commit} onCancel={cancel}/>
    </div>}
    {notice && <small role="status">{uiText(notice)}</small>}
  </details>;
}
