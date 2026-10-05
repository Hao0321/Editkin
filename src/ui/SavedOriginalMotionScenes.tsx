import { useState } from "react";
import type { OriginalSceneGraphicRevisionInput } from "../application/originalSceneGraphicRevision";
import type { MotionScene2D } from "../domain/motionScene2d";
import { motionScene2dSchema } from "../domain/motionScene2dSchema";
import { assertMotionGraphicV2Contract, motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import { assertMotionPaintContract } from "../domain/motionPaint";
import type { EditProject, MotionGraphic, MotionGraphicV2Motion } from "../domain/types";
import { bundledFontFamilies, resolveBundledFontFace } from "../typography/fontFaces";
import "./savedOriginalMotionScenes.css";

interface Props {
  project: EditProject;
  sessionId: number;
  busy: boolean;
  onCancel: () => void;
  onRevise: (input: OriginalSceneGraphicRevisionInput) => void;
}

type GraphicEdit = OriginalSceneGraphicRevisionInput["edits"][number];
type SequenceUnit = MotionGraphicV2Motion["sequence"]["unit"];
type Alignment = "left" | "center" | "right";
interface GraphicDraft {
  graphicId: string;
  text: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: string;
  minFontSize: string;
  maxLines: string;
  letterSpacing: string;
  lineGap: string;
  align: Alignment;
  textColor: string;
  backgroundColor: string;
  paintColors: string[];
  entranceFrames: string;
  exitFrames: string;
  staggerFrames: string;
  exitStaggerFrames: string;
  unit: SequenceUnit;
}

const FAMILIES = bundledFontFamilies();
const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

function physicalWeights(family: string): number[] {
  return [...new Set(Array.from({ length: 17 }, (_, index) =>
    resolveBundledFontFace(family, 100 + index * 50)?.fontWeight).filter((weight): weight is number => weight !== undefined))];
}

function logicalFamily(graphic: MotionGraphic): string | undefined {
  const family = graphic.fontFamily ?? "Noto Sans TC";
  if (FAMILIES.includes(family)) return family;
  // Saved physical aliases still map to the actual bundled logical family.
  return FAMILIES.find(candidate => physicalWeights(candidate).some(weight =>
    resolveBundledFontFace(candidate, weight)?.fontFamily === family));
}

function fillColors(graphic: MotionGraphic): string[] {
  const fill = graphic.paintV1?.fill;
  return !fill ? [] : fill.kind === "solid" ? [fill.color] : fill.stops.map(stop => stop.color);
}

function sameColor(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sceneGraphics(project: EditProject, scene: MotionScene2D): { graphics: MotionGraphic[]; error?: string } {
  const graphics: MotionGraphic[] = [];
  if (!motionScene2dSchema.safeParse(scene).success
    || (project.motionScenes ?? []).filter(owner => owner.id === scene.id).length !== 1
    || !Array.isArray(scene.graphicIds) || !scene.graphicIds.length || new Set(scene.graphicIds).size !== scene.graphicIds.length
    || !Number.isSafeInteger(project.revision) || project.revision < 0
    || !Number.isSafeInteger(scene.startFrame) || scene.startFrame < 0
    || !Number.isSafeInteger(scene.durationFrames) || scene.durationFrames < 2
    || !Number.isSafeInteger(scene.startFrame + scene.durationFrames)
    || !Number.isFinite(project.fps) || project.fps <= 0 || scene.fps !== project.fps) {
    return { graphics, error: "場景身分或影格資料不完整，請先重新開啟有效專案。" };
  }
  for (const id of scene.graphicIds) {
    const matching = project.motionGraphics.filter(graphic => graphic.id === id);
    if (matching.length !== 1 || (project.motionScenes ?? []).some(owner => owner.id !== scene.id && Array.isArray(owner.graphicIds) && owner.graphicIds.includes(id))) {
      return { graphics, error: "場景的圖層來源缺失、重複或由另一個場景共用，不能直接修改。" };
    }
    const graphic = matching[0];
    if (graphic.templateOwner
      || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === id))) {
      return { graphics, error: "這個圖層由模板管理，請從原模板重新編譯。" };
    }
    const first = graphic.timelineStart * project.fps, duration = graphic.duration * project.fps;
    if (graphic.schema !== "hao.motion-composition/v2" || !graphic.motionV2 || !graphic.layoutV2
      || graphic.trackId !== undefined || graphic.trackingMode !== undefined || graphic.compositeLayer === "background"
      || !Number.isSafeInteger(Math.round(first)) || !Number.isSafeInteger(Math.round(duration))
      || Math.abs(first - Math.round(first)) > 1e-6 || Math.abs(duration - Math.round(duration)) > 1e-6
      || first < scene.startFrame || duration < 2 || first + duration > scene.startFrame + scene.durationFrames) {
      return { graphics, error: "圖層的 v2 動態、排版或場景時窗不完整，不能提交修改。" };
    }
    try {
      assertMotionGraphicV2Contract(graphic, project.fps);
      assertMotionPaintContract(graphic);
    } catch {
      return { graphics, error: "圖層包含不合法的動態或原生填色設定，請先修正來源。" };
    }
    if (!graphic.vectorV2 && (!logicalFamily(graphic) || !Number.isSafeInteger(graphic.fontWeight ?? 700)
      || (graphic.fontWeight ?? 700) < 100 || (graphic.fontWeight ?? 700) > 900)) {
      return { graphics, error: "文字圖層沒有可用的內建實體字型，不能以替代字型提交。" };
    }
    graphics.push(graphic);
  }
  return { graphics };
}

function draftFromGraphic(graphic: MotionGraphic): GraphicDraft {
  return {
    graphicId: graphic.id, text: graphic.text, fontFamily: logicalFamily(graphic) ?? "Noto Sans TC",
    fontWeight: String(graphic.fontWeight ?? 700), fontSize: String(graphic.fontSize),
    minFontSize: String(graphic.layoutV2!.minFontSize), maxLines: String(graphic.layoutV2!.maxLines),
    letterSpacing: String(graphic.letterSpacing ?? 0), lineGap: String(graphic.layoutV2!.lineGap), align: graphic.layoutV2!.align,
    textColor: graphic.textColor, backgroundColor: graphic.backgroundColor, paintColors: fillColors(graphic),
    entranceFrames: String(graphic.motionV2!.entrance.durationFrames), exitFrames: String(graphic.motionV2!.exit.durationFrames),
    staggerFrames: String(graphic.motionV2!.sequence.staggerFrames), unit: graphic.motionV2!.sequence.unit,
    exitStaggerFrames: String(motionGraphicV2ExitStaggerFrames(graphic.motionV2!)),
  };
}

function numberDraft(value: string, label: string, minimum: number, maximum: number, integer = false): number {
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || integer && !Number.isSafeInteger(parsed)) {
    throw new Error(`${label}須為 ${minimum}–${maximum} 的${integer ? "整數" : "數值"}。`);
  }
  return parsed;
}

function editedNumberDraft(value: string, original: number, label: string, minimum: number, maximum: number, integer = false): number {
  // A manual edit schema must not rewrite an unchanged, valid saved layout.
  return value === String(original) ? original : numberDraft(value, label, minimum, maximum, integer);
}

function changedEdits(project: EditProject, graphics: readonly MotionGraphic[], drafts: readonly GraphicDraft[]): { edits: GraphicEdit[]; error?: string } {
  const edits: GraphicEdit[] = [];
  try {
    for (const graphic of graphics) {
      const draft = drafts.find(value => value.graphicId === graphic.id);
      if (!draft) throw new Error("圖層草稿已過期，請重新開啟這個場景。");
      const edit: GraphicEdit = { graphicId: graphic.id };
      if (!graphic.vectorV2) {
        if (!draft.text.trim() || draft.text.length > 180 || draft.text !== draft.text.trim() || draft.text.includes("\r")
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(draft.text)) throw new Error("文字須為 1–180 字元，頭尾不能有空白；可手動換行。");
        if (draft.text !== graphic.text) edit.text = draft.text;
        const weight = numberDraft(draft.fontWeight, "字重", 100, 900, true);
        const face = resolveBundledFontFace(draft.fontFamily, weight);
        if (!face || face.weightSubstituted) throw new Error("請選擇這個內建字型實際提供的字重。");
        if (draft.fontFamily !== logicalFamily(graphic) || weight !== (graphic.fontWeight ?? 700)) {
          edit.fontFamily = draft.fontFamily; edit.fontWeight = face.fontWeight;
        }
        const fontSize = editedNumberDraft(draft.fontSize, graphic.fontSize, "字級", 8, 384);
        const minFontSize = editedNumberDraft(draft.minFontSize, graphic.layoutV2!.minFontSize, "最小字級", 8, Math.min(384, fontSize), true);
        const maxLines = editedNumberDraft(draft.maxLines, graphic.layoutV2!.maxLines, "最多行數", 1, 4, true);
        const letterSpacing = editedNumberDraft(draft.letterSpacing, graphic.letterSpacing ?? 0, "字距", -16, 64);
        const lineGap = editedNumberDraft(draft.lineGap, graphic.layoutV2!.lineGap, "行距", 0, 64);
        if (fontSize !== graphic.fontSize) edit.fontSize = fontSize;
        if (minFontSize !== graphic.layoutV2!.minFontSize) edit.minFontSize = minFontSize;
        if (maxLines !== graphic.layoutV2!.maxLines) edit.maxLines = maxLines;
        if (letterSpacing !== (graphic.letterSpacing ?? 0)) edit.letterSpacing = letterSpacing;
        if (lineGap !== graphic.layoutV2!.lineGap) edit.lineGap = lineGap;
        if (!["left", "center", "right"].includes(draft.align)) throw new Error("請選擇有效的文字對齊。");
        if (draft.align !== graphic.layoutV2!.align) edit.align = draft.align;
      }
      if (graphic.paintV1) {
        const originalColors = fillColors(graphic);
        if (draft.paintColors.length !== originalColors.length || draft.paintColors.some((color, index) =>
          !HEX_COLOR.test(color) || color.slice(7).toLowerCase() !== originalColors[index].slice(7).toLowerCase())) {
          throw new Error("填色須保留原本的色階數量與透明度。");
        }
        if (draft.paintColors.some((color, index) => !sameColor(color, originalColors[index]))) edit.paintColors = [...draft.paintColors];
      } else {
        for (const field of ["textColor", "backgroundColor"] as const) {
          const color = draft[field];
          if (!HEX_COLOR.test(color) || color.slice(7).toLowerCase() !== graphic[field].slice(7).toLowerCase()) throw new Error("填色須保留原本的透明度。");
          if (!sameColor(color, graphic[field])) edit[field] = color;
        }
      }
      const maximumFrames = Math.min(600, Math.round(graphic.duration * project.fps));
      const entranceFrames = numberDraft(draft.entranceFrames, "進場影格", 1, maximumFrames, true);
      const exitFrames = numberDraft(draft.exitFrames, "退場影格", 1, maximumFrames, true);
      const staggerFrames = numberDraft(draft.staggerFrames, "單元間隔影格", 0, 120, true);
      const exitStaggerFrames = numberDraft(draft.exitStaggerFrames, "退場間隔影格", 0, 120, true);
      if (!["all", "word", "character"].includes(draft.unit)) throw new Error("請選擇有效的動畫單元。");
      if (entranceFrames !== graphic.motionV2!.entrance.durationFrames || exitFrames !== graphic.motionV2!.exit.durationFrames
        || staggerFrames !== graphic.motionV2!.sequence.staggerFrames || draft.unit !== graphic.motionV2!.sequence.unit
        || exitStaggerFrames !== motionGraphicV2ExitStaggerFrames(graphic.motionV2!)) {
        edit.motionV2 = { ...structuredClone(graphic.motionV2!),
          entrance: { ...structuredClone(graphic.motionV2!.entrance), durationFrames: entranceFrames },
          exit: { ...structuredClone(graphic.motionV2!.exit), durationFrames: exitFrames },
          sequence: { ...graphic.motionV2!.sequence, unit: draft.unit, staggerFrames,
            ...(exitStaggerFrames !== staggerFrames || graphic.motionV2!.sequence.exitStaggerFrames !== undefined ? { exitStaggerFrames } : {}) } };
      }
      const prospective: MotionGraphic = { ...graphic, ...(edit.text !== undefined ? { text: edit.text } : {}),
        fontSize: edit.fontSize ?? graphic.fontSize, letterSpacing: edit.letterSpacing ?? graphic.letterSpacing,
        motionV2: edit.motionV2 ?? graphic.motionV2,
        layoutV2: { ...graphic.layoutV2!, minFontSize: edit.minFontSize ?? graphic.layoutV2!.minFontSize,
          maxLines: edit.maxLines ?? graphic.layoutV2!.maxLines, lineGap: edit.lineGap ?? graphic.layoutV2!.lineGap,
          align: edit.align ?? graphic.layoutV2!.align } };
      assertMotionGraphicV2Contract(prospective, project.fps);
      if (Object.keys(edit).length > 1) edits.push(edit);
    }
    return { edits };
  } catch (error) {
    return { edits: [], error: error instanceof Error ? error.message : "請檢查文字、填色與影格設定。" };
  }
}

function ColorControl({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const valid = HEX_COLOR.test(value);
  return <label className="saved-original-color"><span>{label}</span><span className="saved-original-color-value">
    <input type="color" aria-label={label} value={valid ? value.slice(0, 7) : "#000000"} disabled={disabled || !valid}
      onChange={event => { if (!disabled && valid && /^#[0-9a-f]{6}$/i.test(event.target.value)) onChange(event.target.value + value.slice(7)); }} />
    <code>{value}</code>
  </span></label>;
}

function SceneControls({ project, scene, busy, onCancel, onRevise }: Omit<Props, "sessionId"> & { scene: MotionScene2D }) {
  const selection = sceneGraphics(project, scene);
  const [drafts, setDrafts] = useState(() => selection.error ? [] : selection.graphics.map(draftFromGraphic));
  const [submitError, setSubmitError] = useState<string>();
  const changes = selection.error ? { edits: [], error: selection.error } : changedEdits(project, selection.graphics, drafts);
  const disabled = busy || Boolean(selection.error);
  function patch(graphicId: string, value: Partial<GraphicDraft>) {
    if (busy || selection.error) return;
    setSubmitError(undefined);
    setDrafts(current => current.map(draft => draft.graphicId === graphicId ? { ...draft, ...value } : draft));
  }
  return <details className="inspector-section saved-original-scene" data-testid="saved-original-motion-scene" aria-busy={busy}>
    <summary>原創動態場景 <small>{scene.id}</small></summary>
    <form noValidate className="inspector-advanced-body saved-original-scene-body" onSubmit={event => {
      event.preventDefault();
      if (busy || selection.error) return;
      const current = changedEdits(project, selection.graphics, drafts);
      if (current.error || !current.edits.length) { setSubmitError(current.error); return; }
      try { onRevise({ sceneId: scene.id, expectedRevision: project.revision, edits: current.edits }); }
      catch (error) { setSubmitError(error instanceof Error ? error.message : "場景修改未提交。"); }
    }}>
      <p className="saved-original-frame-window">場景影格 {scene.startFrame}–{scene.startFrame + scene.durationFrames - 1} · {scene.fps} fps<br />鏡頭、時鐘、圖層位置與形狀維持原設定。</p>
      <fieldset disabled={disabled} className="saved-original-fields">
        {selection.graphics.map(graphic => {
          const draft = drafts.find(value => value.graphicId === graphic.id);
          if (!draft) return null;
          const name = graphic.name || graphic.id;
          const numberField = (label: string, field: "fontSize" | "minFontSize" | "maxLines" | "letterSpacing" | "lineGap" | "entranceFrames" | "exitFrames" | "staggerFrames" | "exitStaggerFrames", min: number, max: number, step: string) =>
            <label className="field-label"><span>{label}</span><input aria-label={`${name} ${label}`} type="number" min={min} max={max} step={step}
              disabled={disabled || Boolean(graphic.vectorV2) && (field === "staggerFrames" || field === "exitStaggerFrames")}
              value={draft[field]} onChange={event => patch(graphic.id, { [field]: event.target.value })} /></label>;
          return <section className="saved-original-graphic" key={graphic.id} aria-label={name}>
            <header><strong>{name}</strong><small>影格 {Math.round(graphic.timelineStart * project.fps)}–{Math.round((graphic.timelineStart + graphic.duration) * project.fps) - 1}</small></header>
            {!graphic.vectorV2 && <>
              <label className="field-label"><span>文字 · 可手動換行</span><textarea aria-label={`${name} 文字`} rows={3} maxLength={180} value={draft.text}
                onChange={event => patch(graphic.id, { text: event.target.value })} /></label>
              <div className="saved-original-grid">
                <label className="field-label"><span>內建字型</span><select aria-label={`${name} 內建字型`} value={draft.fontFamily} onChange={event => {
                  if (busy || selection.error || !FAMILIES.includes(event.target.value)) return;
                  const requested = Number(draft.fontWeight), face = resolveBundledFontFace(event.target.value, Number.isFinite(requested) ? requested : 700);
                  if (face) patch(graphic.id, { fontFamily: event.target.value, fontWeight: String(face.fontWeight) });
                }}>{FAMILIES.map(family => <option value={family} key={family}>{family}</option>)}</select></label>
                <label className="field-label"><span>實體字重</span><select aria-label={`${name} 實體字重`} value={draft.fontWeight}
                  onChange={event => { if (physicalWeights(draft.fontFamily).includes(Number(event.target.value))) patch(graphic.id, { fontWeight: event.target.value }); }}>
                  {physicalWeights(draft.fontFamily).map(weight => <option key={weight} value={weight}>{weight}</option>)}
                </select></label>
                {numberField("字級", "fontSize", 8, 384, "any")}
                {numberField("最小字級", "minFontSize", 8, 384, "1")}
                {numberField("最多行數", "maxLines", 1, 4, "1")}
                {numberField("字距 px", "letterSpacing", -16, 64, "any")}
                {numberField("行距 px", "lineGap", 0, 64, "any")}
                <label className="field-label"><span>文字對齊</span><select aria-label={`${name} 文字對齊`} value={draft.align}
                  onChange={event => { if (["left", "center", "right"].includes(event.target.value)) patch(graphic.id, { align: event.target.value as Alignment }); }}>
                  <option value="left">靠左</option><option value="center">置中</option><option value="right">靠右</option>
                </select></label>
              </div>
            </>}
            <div className="saved-original-colors">
              {graphic.paintV1 ? draft.paintColors.map((color, index) => {
                const fill = graphic.paintV1!.fill;
                const label = fill.kind === "solid" ? "原生填色" : `漸層色階 ${index + 1} · ${Math.round(fill.stops[index].at * 100)}%`;
                return <ColorControl key={index} label={`${name} ${label}`} value={color} disabled={disabled} onChange={value =>
                  patch(graphic.id, { paintColors: draft.paintColors.map((previous, slot) => slot === index ? value : previous) })} />;
              }) : <>
                {!graphic.vectorV2 && <ColorControl label={`${name} 文字填色`} value={draft.textColor} disabled={disabled} onChange={value => patch(graphic.id, { textColor: value })} />}
                <ColorControl label={`${name} 背景填色`} value={draft.backgroundColor} disabled={disabled} onChange={value => patch(graphic.id, { backgroundColor: value })} />
              </>}
              <small>保留每個色階的透明度與位置。</small>
            </div>
            <div className="saved-original-grid">
              {numberField("進場影格", "entranceFrames", 1, Math.min(600, Math.round(graphic.duration * project.fps)), "1")}
              {numberField("退場影格", "exitFrames", 1, Math.min(600, Math.round(graphic.duration * project.fps)), "1")}
              <label className="field-label"><span>動畫單元</span><select aria-label={`${name} 動畫單元`} value={draft.unit} disabled={disabled || Boolean(graphic.vectorV2)}
                onChange={event => { if (["all", "word", "character"].includes(event.target.value)) patch(graphic.id, { unit: event.target.value as SequenceUnit }); }}>
                <option value="all">整層</option><option value="word">逐詞</option><option value="character">逐字</option>
              </select></label>
              {numberField("單元間隔影格", "staggerFrames", 0, 120, "1")}
              {numberField("退場間隔影格（0 = 整句）", "exitStaggerFrames", 0, 120, "1")}
            </div>
            <small className="saved-original-preserved-motion">保留進退場位移、縮放、透明度、緩動與原有播放順序。</small>
          </section>;
        })}
      </fieldset>
      <p className="saved-original-output-note">手動改字後請檢查換行、字型、閱讀停留與正式輸出。瀏覽器尚不支援原生 paint 預覽。</p>
      {(submitError || changes.error) && <p className="saved-original-error" role="status">{submitError || changes.error}</p>}
      <button className="primary-tool-action" type="submit" disabled={disabled || Boolean(changes.error) || !changes.edits.length}>重新準備並套用變更</button>
      {busy && <div className="saved-original-progress" role="status">正在重新準備實體字形與場景…<button type="button" onClick={() => { if (busy) onCancel(); }}>取消準備</button></div>}
    </form>
  </details>;
}

/** A saved scene remains the sole owner; drafts do not invent media or source rights. */
export function SavedOriginalMotionScenes({ project, sessionId, busy, onCancel, onRevise }: Props) {
  const scenes = project.motionScenes ?? [];
  if (!scenes.length) return null;
  return <div className="saved-original-motion-scenes" data-testid="saved-original-motion-scenes">
    {scenes.map((scene, index) => <SceneControls key={`${sessionId}:${scene.id}:${project.revision}:${project.updatedAt}:${index}`}
      project={project} scene={scene} busy={busy} onCancel={onCancel} onRevise={onRevise} />)}
  </div>;
}
