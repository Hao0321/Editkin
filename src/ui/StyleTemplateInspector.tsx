import { useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import type { EditorCommand } from "../domain/commandTypes";
import type { StyleImageSlotValueV1, StyleSlotValuesV1 } from "../domain/styleJobFieldsV1";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import {
  createStyleTemplateInspectorControllerV1, styleTemplateResetColorV1, styleTemplateStillAtPlayheadV1, styleTemplateTextCounterV1,
} from "../styleTemplates/slots/inspectorModel";
import { resolveStyleTemplateRenderHostV1, type StyleTemplateRenderHostV1 } from "../styleTemplates/slots/renderHost";
import { findStyleSlotTemplateV1 } from "../styleTemplates/slots/slotCatalog";
import { styleSlotLabel, type StyleImageSlot } from "../styleTemplates/slots/slotSchema";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { MotionLibraryIcon } from "./MotionLibraryIcons";
import "./motionLibrary.css";
import "./styleTemplateInspector.css";

/**
 * Inspector section 「模板片段」 for a style-template clip (TimelineClip.styleJob): one text field per text slot with a live
 * character counter, a colour well per palette role with 「恢復」 (back to the template), and per picture slot the source
 * (project media, the frame under the playhead, or an imported file), 填滿／完整 and a focal point you drag or move
 * with the arrow keys. Same look as the Motion Library inspector. An edit re-renders after a short pause with a progress
 * bar (Esc or 取消 stops it) and lands as one Undo; text over its limit is shown and never rendered.
 */

export interface StyleTemplateInspectorProps {
  readonly project: EditProject;
  readonly clip: TimelineClip;
  readonly playhead: number;
  readonly onCommand: (command: EditorCommand) => boolean | void;
  /** Default: this runtime's host (desktop bridge or a dev override); null = no host. */
  readonly host?: StyleTemplateRenderHostV1 | null;
  readonly mergeRuntimeUrls?: (urls: Record<string, string>) => void;
  /** Test seam: the pause (ms) before an edit re-renders. */
  readonly commitDelayMs?: number;
}

const STEP = 0.05;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export default function StyleTemplateInspector({ project, clip, playhead, onCommand, host, mergeRuntimeUrls, commitDelayMs }: StyleTemplateInspectorProps) {
  const { locale } = useI18n();
  const live = useRef({ project, onCommand, mergeRuntimeUrls });
  live.current = { project, onCommand, mergeRuntimeUrls };
  const resolvedHost = host === undefined ? resolveStyleTemplateRenderHostV1() : host ?? undefined;
  const controller = useMemo(() => createStyleTemplateInspectorControllerV1({ getProject: () => live.current.project, clipId: clip.id, host: resolvedHost,
    runCommand: command => live.current.onCommand(command), mergeRuntimeUrls: urls => live.current.mergeRuntimeUrls?.(urls), delayMs: commitDelayMs }),
  // The controller belongs to this clip and host for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [clip.id, resolvedHost]);
  useEffect(() => () => controller.dispose(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Undo / Redo / another edit replaced the clip's slots: show them (unless an edit of ours is waiting).
  useEffect(() => { controller.sync(); }, [controller, clip.styleJob?.key]);

  const field = clip.styleJob;
  const template = field ? findStyleSlotTemplateV1(field.template.id) : undefined;
  if (!field || !template) return null;
  const draft = state.draft;
  const edit = (next: StyleSlotValuesV1, assets?: readonly MediaAsset[]) => controller.edit(next, assets);
  const label = (value: Parameters<typeof styleSlotLabel>[0]) => styleSlotLabel(value, locale);
  const busy = state.status === "rendering";
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && (busy || state.status === "waiting")) { event.stopPropagation(); controller.cancel(); } };
  const palette = template.palette as Record<string, string | undefined>;

  return <section className="inspector-section ml-inspector st-inspector" data-testid="style-template-inspector" data-template-id={template.id} aria-label={uiText("模板片段")} onKeyDown={onKeyDown}>
    <header className="ml-inspector-head">
      <span className="ml-title-mark"><MotionLibraryIcon name="text" size={15} /></span>
      <div><strong>{uiText("模板片段")}</strong><span>{template.names.zh}<small> · {template.id} r{template.revision} · {uiText("可改字・改色・換圖")}</small></span></div>
      {template.artStatus !== "certified" && <span className="ml-badge is-inline">{uiText("未認證")}</span>}
    </header>

    {state.status === "rendering" && state.progress && <div className="st-job" role="status" data-testid="style-template-progress">
      <span>{uiText("正在重新產生模板… {value0}%", { value0: Math.round(state.progress.fraction * 100) })}</span>
      <i className="st-bar" aria-hidden="true"><b style={{ width: `${Math.round(state.progress.fraction * 100)}%` }} /></i>
      <button type="button" onClick={() => controller.cancel()} aria-keyshortcuts="Escape" title={uiText("取消")}><MotionLibraryIcon name="close" size={12} />{uiText("取消")}</button>
    </div>}
    {state.status === "waiting" && <p className="ml-note" role="status">{uiText("停一下就會重新產生")}</p>}
    {state.status === "applied" && <p className="ml-note" role="status">{uiText("已套用，可復原。")}</p>}
    {state.status === "no_host" && state.message && <p className="ml-note" data-testid="style-template-no-host">{uiText(state.message)}</p>}
    {state.status === "invalid" && state.message && <p className="ml-error" role="alert" data-testid="style-template-invalid">{state.message}</p>}
    {state.status === "failed" && state.message && <p className="ml-error" role="alert">{uiText("重新產生失敗：{value0}", { value0: state.message })}</p>}
    {!template.implemented && <p className="ml-note">{uiText("這個模板的設計還在製作中，暫時只能檢視。")}</p>}

    {template.slots.text.length > 0 && <div className="ml-field">
      <span className="ml-label">{uiText("文字")}</span>
      {template.slots.text.map(slot => {
        const value = draft.text[slot.id] ?? "", counter = styleTemplateTextCounterV1(slot, value);
        return <label key={slot.id} className="st-text" data-over={counter.over || undefined}>
          <span className="st-text-head"><span>{label(slot.label)}{slot.required && <em>{uiText("必填")}</em>}</span>
            <small className="st-counter" data-testid={`style-template-count-${slot.id}`} aria-live="polite">{counter.length}/{counter.max}</small></span>
          <input type="text" value={value} data-testid={`style-template-text-${slot.id}`} aria-invalid={counter.over || (slot.required && !value.trim()) || undefined}
            aria-label={label(slot.label)} onChange={event => edit({ ...draft, text: { ...draft.text, [slot.id]: event.target.value } })} />
          {counter.over && <small className="st-over" role="alert">{uiText("超過字數上限")}</small>}
        </label>;
      })}
    </div>}

    {template.slots.color.length > 0 && <div className="ml-field">
      <span className="ml-label">{uiText("顏色")}
        {Object.keys(draft.color).length > 0 && <button type="button" className="mini-action st-reset-all" data-testid="style-template-reset-colors"
          onClick={() => edit(styleTemplateResetColorV1(draft))}>{uiText("恢復模板顏色")}</button>}</span>
      <div className="ml-wells">
        {template.slots.color.map(slot => {
          const override = (draft.color as Record<string, string | undefined>)[slot.role], value = override ?? palette[slot.role] ?? "#000000";
          return <div key={slot.role} className="st-color">
            <label className="ml-well" title={label(slot.label)}>
              <input type="color" value={value.toLowerCase()} aria-label={label(slot.label)} data-testid={`style-template-color-${slot.role}`}
                onChange={event => edit({ ...draft, color: { ...draft.color, [slot.role]: event.target.value.toUpperCase() } })} />
              <span>{label(slot.label)}</span>
            </label>
            <code>{value.toUpperCase()}</code>
            {override !== undefined && <button type="button" className="ml-icon-button" data-testid={`style-template-reset-${slot.role}`} title={uiText("恢復這個顏色")}
              aria-label={uiText("恢復這個顏色")} onClick={() => edit(styleTemplateResetColorV1(draft, slot.role))}><MotionLibraryIcon name="close" size={12} /></button>}
          </div>;
        })}
      </div>
    </div>}

    {template.slots.image.map(slot => <ImageSlotEditor key={slot.id} slot={slot} label={label(slot.label)} project={project} playhead={playhead}
      value={draft.image[slot.id]} host={resolvedHost} pending={state.pendingAssets}
      onChange={(value, assets) => {
        const image = { ...draft.image } as Record<string, StyleImageSlotValueV1>;
        if (value) image[slot.id] = value; else delete image[slot.id];
        edit({ ...draft, image }, assets);
      }} />)}
  </section>;
}

function ImageSlotEditor({ slot, label, project, playhead, value, host, pending, onChange }: {
  slot: StyleImageSlot; label: string; project: EditProject; playhead: number; value: StyleImageSlotValueV1 | undefined;
  host: StyleTemplateRenderHostV1 | undefined; pending: readonly MediaAsset[]; onChange: (value: StyleImageSlotValueV1 | undefined, assets?: readonly MediaAsset[]) => void;
}) {
  const pictures = [...project.assets, ...pending.filter(asset => !project.assets.some(existing => existing.id === asset.id))].filter(asset => asset.kind === "image" && !asset.compositionId);
  const source = value?.source;
  const fit = value?.fit ?? slot.fit, focal = value?.focal ?? slot.focal;
  const asset = source ? [...project.assets, ...pending].find(candidate => candidate.id === source.assetId) : undefined;
  const still = styleTemplateStillAtPlayheadV1(project, playhead);
  const set = (patch: Partial<StyleImageSlotValueV1>) => value && onChange({ ...value, ...patch });
  const pad = useRef<HTMLDivElement>(null);
  const placeFocal = (event: PointerEvent<HTMLDivElement>) => {
    const box = pad.current?.getBoundingClientRect();
    if (!box || !value || box.width <= 0 || box.height <= 0) return;
    set({ focal: [Number(clamp01((event.clientX - box.left) / box.width).toFixed(3)), Number(clamp01((event.clientY - box.top) / box.height).toFixed(3))] });
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? STEP * 4 : STEP;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key as "ArrowLeft"];
    if (!delta || !value) return;
    event.preventDefault(); event.stopPropagation();
    set({ focal: [Number(clamp01(focal[0] + delta[0]).toFixed(3)), Number(clamp01(focal[1] + delta[1]).toFixed(3))] });
  };
  const thumb = asset && asset.kind === "image" ? host?.assetUrl?.(asset) : undefined;
  return <div className="ml-field st-image" data-testid={`style-template-image-${slot.id}`}>
    <span className="ml-label">{uiText("圖片")} · {label}{slot.required && <em>{uiText("必填")}</em>}</span>
    <div className="st-sources">
      <select aria-label={uiText("選擇專案圖片")} data-testid={`style-template-picture-${slot.id}`} value={source?.kind === "asset" ? source.assetId : ""}
        onChange={event => { const id = event.target.value; if (id) onChange({ ...(value ?? {}), source: { kind: "asset", assetId: id } }); }}>
        <option value="">{uiText("專案素材")}…</option>
        {pictures.map(picture => <option key={picture.id} value={picture.id}>{picture.name}</option>)}
      </select>
      <button type="button" className="mini-action" data-testid={`style-template-still-${slot.id}`} disabled={!still}
        title={still ? undefined : uiText("播放頭下沒有可用的影片畫面")} onClick={() => still && onChange({ ...(value ?? {}), source: still })}>
        <MotionLibraryIcon name="play" size={12} />{uiText("播放頭畫面")}</button>
      <button type="button" className="mini-action" data-testid={`style-template-file-${slot.id}`} disabled={!host?.pickImageFile}
        onClick={async () => { const picked = await host?.pickImageFile?.(); if (picked) onChange({ ...(value ?? {}), source: { kind: "asset", assetId: picked.id } }, [picked]); }}>
        <MotionLibraryIcon name="plus" size={12} />{uiText("匯入圖檔")}</button>
      {value && <button type="button" className="mini-action danger-action" data-testid={`style-template-clear-${slot.id}`} onClick={() => onChange(undefined)}>{uiText("移除圖片")}</button>}
    </div>
    {value ? <>
      <small className="st-source">{asset?.name ?? source?.assetId}{source?.kind === "still" ? ` @ ${source.time.toFixed(2)}s` : ""}</small>
      <div className="ml-segmented" role="group" aria-label={uiText("圖片")}>
        {(["cover", "contain"] as const).map(option => <button key={option} type="button" aria-pressed={fit === option} data-testid={`style-template-fit-${option}`}
          onClick={() => set({ fit: option })}>{uiText(option === "cover" ? "填滿" : "完整")}</button>)}
      </div>
      <div ref={pad} className="st-focal" role="slider" tabIndex={0} aria-label={uiText("重點位置")} aria-valuetext={`${Math.round(focal[0] * 100)}%, ${Math.round(focal[1] * 100)}%`}
        title={uiText("拖曳或用方向鍵移動重點")} data-testid={`style-template-focal-${slot.id}`}
        style={{ aspectRatio: String(slot.aspect.portrait), ...(thumb ? { backgroundImage: `url("${thumb.replace(/"/g, "%22")}")` } : {}) }}
        onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); placeFocal(event); }}
        onPointerMove={event => { if (event.buttons & 1) placeFocal(event); }} onKeyDown={nudge}>
        <i style={{ left: `${focal[0] * 100}%`, top: `${focal[1] * 100}%` }} />
      </div>
    </> : slot.placeholder === "ui_panel" ? <small className="ml-hint">{uiText("沒有圖片時顯示示意介面")}</small> : null}
  </div>;
}
