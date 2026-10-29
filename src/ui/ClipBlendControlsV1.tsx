import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { LayerBlendMode, TimelineClip } from "../domain/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { CLIP_BLEND_MODE_GROUPS_V1, CLIP_BLEND_MODES_V1, clipBlendModeCssV1, clipBlendModeLabelV1, createBlendHoverPreviewV1 } from "./clipBlendModesV1";
import { useClipLayerHostV1 } from "./clipLayerHostV1";
import { createParameterRangeGestureInputV1 } from "./parameterRangeGestureInputV1";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";
import "./clipBlendControls.css";

/** Where the 混合模式 list opens: under its button when it fits, else above; always inside the window. */
export function blendMenuPositionV1(anchor: { left: number; top: number; bottom: number; width: number }, width: number, height: number) {
  const margin = 8, menuWidth = Math.min(Math.max(anchor.width, 212), Math.max(0, width - margin * 2)), wanted = 420;
  const below = height - anchor.bottom - margin * 2, above = anchor.top - margin * 2;
  const openBelow = below >= Math.min(wanted, 260) || below >= above;
  const maxHeight = Math.max(120, Math.min(wanted, openBelow ? below : above));
  return { left: Math.max(margin, Math.min(anchor.left, width - menuWidth - margin)), width: menuWidth, maxHeight,
    top: openBelow ? Math.min(anchor.bottom + 4, height - maxHeight - margin) : Math.max(margin, anchor.top - 4 - maxHeight) };
}

/** The keyframe at the playhead (half a frame either way), as the timeline's ◆ shows it. */
export function keyframeAtPlayheadV1(clip: TimelineClip, playhead: number, fps: number) {
  const local = playhead - clip.timelineStart;
  if (local < 0 || local > clip.duration) return { inside: false as const };
  return { inside: true as const, keyframe: clip.keyframes.find(keyframe => Math.abs(keyframe.time - local) <= .5 / fps) };
}

const LOCKED = "這個軌道已鎖定，先解鎖才能修改。";
const percent = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100);

/**
 * Inspector › 片段工具 › 調整 › 混合, in simple and advanced mode (CapCut's Basic tab): 混合模式 with a live hover preview,
 * 不透明度 as a slider and a number, and ◆ for a keyframe at the playhead. Everything goes through the editor shell's
 * own command, gesture and history owners (ClipLayerHostV1); this component keeps only its open list and the pointer.
 */
export function ClipBlendControlsV1({ clip }: { clip: TimelineClip }) {
  useI18n();
  const host = useClipLayerHostV1();
  const ids = useId();
  const [menu, setMenu] = useState<ReturnType<typeof blendMenuPositionV1>>();
  const [active, setActive] = useState<LayerBlendMode>();
  const preview = useMemo(() => createBlendHoverPreviewV1(), []);
  const range = useMemo(() => createParameterRangeGestureInputV1(), []);
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  // Another clip, project or playhead position: any preview or held slider of the old one ends.
  useEffect(() => () => { preview.restore(); range.cancel(); }, [preview, range, clip.id, host?.editScope]);
  useEffect(() => host?.editScopeSignal?.subscribe(() => { preview.restore(); range.cancel(); }), [preview, range, host?.editScopeSignal]);
  const close = (focusTrigger = false) => { preview.restore(); setMenu(undefined); setActive(undefined); if (focusTrigger) trigger.current?.focus(); };
  useEffect(() => {
    if (!menu) return;
    list.current?.focus();
    const outside = (event: Event) => { const target = event.target as Node | null; if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(); };
    const moved = (event: Event) => { if (!list.current?.contains(event.target as Node | null)) close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", moved, true);
    const resized = () => close();
    window.addEventListener("resize", resized);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", moved, true); window.removeEventListener("resize", resized); };
  }, [menu]);
  if (!host || host.clipId !== clip.id) return null;

  const track = host.project.tracks.find(item => item.clips.some(candidate => candidate.id === clip.id));
  const locked = Boolean(track?.locked), role = clip.layer?.role ?? "content";
  const committed = clip.layer?.blendMode ?? "normal", shown = host.blendPreview ?? committed;
  const blendBlocked = locked ? LOCKED : role === "controller" ? "Null 控制器不會顯示畫面，不使用混合模式。" : role === "adjustment" ? "調整圖層直接調整下方畫面，不使用混合模式。" : undefined;
  const opacityBlocked = locked ? LOCKED : role === "adjustment" ? "調整圖層直接調整下方畫面，不使用不透明度。"
    : clip.expressions?.opacity ? "此屬性由表達式控制，請先停用表達式再修改。" : undefined;
  const opacity = host.opacity ?? clip.transform.opacity;
  const keyed = keyframeAtPlayheadV1(clip, host.playhead, host.fps);
  const keyBlocked = locked ? LOCKED : !keyed.inside ? "把播放頭移到這個片段上，再加入關鍵幀。" : undefined;
  const begin = host.beginBlendGesture;
  const hover = (mode: LayerBlendMode) => { setActive(mode); preview.hover(mode, begin); };
  const choose = (mode: LayerBlendMode) => {
    preview.choose(mode, next => host.onLayerChange({ blendMode: next }));
    setMenu(undefined); setActive(undefined); trigger.current?.focus();
  };
  const open = () => {
    if (blendBlocked) return;
    const rect = trigger.current?.getBoundingClientRect();
    setMenu(rect ? blendMenuPositionV1(rect, window.innerWidth, window.innerHeight) : { left: 8, top: 8, width: 212, maxHeight: 420 });
    setActive(committed);
  };
  const step = (from: LayerBlendMode | undefined, by: number | "first" | "last") => {
    const index = CLIP_BLEND_MODES_V1.indexOf(from ?? committed);
    return by === "first" ? CLIP_BLEND_MODES_V1[0] : by === "last" ? CLIP_BLEND_MODES_V1.at(-1)!
      : CLIP_BLEND_MODES_V1[(index + by + CLIP_BLEND_MODES_V1.length) % CLIP_BLEND_MODES_V1.length];
  };
  const triggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) || menu) return;
    event.preventDefault(); open();
  };
  const listKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
    if (event.key in moves) { event.preventDefault(); hover(step(active, moves[event.key])); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active ?? committed); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") close();
  };
  const swatch = (mode: LayerBlendMode) => <i className="clip-blend-swatch" aria-hidden="true"><b style={{ mixBlendMode: clipBlendModeCssV1(mode) }} /></i>;
  const optionId = (mode: LayerBlendMode) => `${ids}-mode-${mode}`;
  const listbox = menu && <div ref={list} className="clip-blend-menu" role="listbox" id={`${ids}-list`} aria-label={uiText("混合模式")} tabIndex={-1}
    aria-activedescendant={active ? optionId(active) : undefined} data-testid="clip-blend-menu" data-drop-zone="blocked"
    style={{ left: menu.left, top: menu.top, width: menu.width, maxHeight: menu.maxHeight }} onKeyDown={listKey}
    onPointerLeave={() => { preview.restore(); setActive(undefined); }}>
    {CLIP_BLEND_MODE_GROUPS_V1.map(group => <div role="group" key={group.label} aria-label={uiText(group.label)} className="clip-blend-group">
      {group.modes.length > 1 && <small aria-hidden="true">{uiText(group.label)}</small>}
      {group.modes.map(mode => <div key={mode} role="option" id={optionId(mode)} aria-selected={mode === committed} data-active={mode === active || undefined}
        data-blend-mode={mode} data-testid={`clip-blend-option-${mode}`} onPointerEnter={() => hover(mode)} onClick={() => choose(mode)}>
        {swatch(mode)}<span>{uiText(clipBlendModeLabelV1(mode))}</span>{mode === committed && <b aria-hidden="true">✓</b>}
      </div>)}
    </div>)}
  </div>;
  const gesture = host.beginOpacityGesture && !opacityBlocked ? range.bind(`${clip.id}:opacity`, host.beginOpacityGesture) : undefined;
  return <section className="clip-blend-controls" data-testid="clip-blend-controls" aria-labelledby={`${ids}-title`}>
    <div className="clip-blend-heading"><strong id={`${ids}-title`}>{uiText("混合")}</strong><span>{uiText("疊到下方畫面的方式與不透明度")}</span></div>
    <div className="clip-blend-row">
      <div className="clip-blend-mode">
        <span id={`${ids}-label`}>{uiText("混合模式")}</span>
        <button ref={trigger} type="button" className="clip-blend-trigger" data-testid="clip-blend-mode" data-blend-mode={shown}
          aria-haspopup="listbox" aria-expanded={Boolean(menu)} aria-controls={menu ? `${ids}-list` : undefined} aria-labelledby={`${ids}-label ${ids}-value`}
          disabled={Boolean(blendBlocked)} title={blendBlocked ? uiText(blendBlocked) : uiText("指到選項就能預覽；按一下套用，Esc 還原")}
          onClick={() => menu ? close() : open()} onKeyDown={triggerKey}>
          {swatch(shown)}<span id={`${ids}-value`}>{uiText(clipBlendModeLabelV1(shown))}</span><b aria-hidden="true">▾</b>
        </button>
      </div>
      <div className="clip-blend-opacity" title={opacityBlocked ? uiText(opacityBlocked) : undefined}>
        <span id={`${ids}-opacity`}>{uiText("不透明度")}</span>
        <input type="range" min="0" max="100" step="1" value={percent(host.opacityPreview ?? opacity)} disabled={Boolean(opacityBlocked)}
          aria-labelledby={`${ids}-opacity`} data-testid="clip-opacity-slider" {...gesture?.events}
          onChange={event => { const next = event.currentTarget.valueAsNumber / 100; if (!gesture?.change(event.currentTarget, next)) host.onOpacityChange(next); }} />
        <NumberEditFieldV1 min="0" max="100" step="1" value={percent(opacity)} scope={host.editScope} scopeSignal={host.editScopeSignal} disabled={Boolean(opacityBlocked)}
          aria-label={uiText("不透明度（%）")} data-testid="clip-opacity-number" onCommit={value => value >= 0 && value <= 100 ? host.onOpacityChange(value / 100) : false} />
        <span aria-hidden="true">%</span>
      </div>
      <button type="button" className="clip-blend-keyframe" data-testid="clip-opacity-keyframe" aria-pressed={Boolean(keyed.inside && keyed.keyframe)}
        disabled={Boolean(keyBlocked)} aria-label={uiText(keyed.inside && keyed.keyframe ? "刪除目前時間的關鍵幀" : "在目前時間加入關鍵幀")}
        title={keyBlocked ? uiText(keyBlocked) : uiText(keyed.inside && keyed.keyframe ? "刪除目前時間的關鍵幀" : "在目前時間加入關鍵幀：記下這一格的不透明度、位置、大小與色彩")}
        onClick={() => { if (!keyed.inside) return; if (keyed.keyframe) host.onDeleteKeyframe(keyed.keyframe.id); else host.onAddKeyframe(); }}>◆</button>
    </div>
    {listbox && (typeof document === "undefined" ? listbox : createPortal(listbox, document.body))}
  </section>;
}
