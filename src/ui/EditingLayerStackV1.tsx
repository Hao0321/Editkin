import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { EditProject, TimelineClip, TimelineTrack } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { translateUi as pageText, useI18n } from "./i18n/interfacePreferences";
import type { EditingLayerSelectionV1 } from "./editingWorkspaceV1";
import { createEditingTrackIndexV1, editingLayerDisclosureOpenV1, editingLayerLocationV1, editingLayerPageV1,
  EDITING_LAYER_PAGE_SIZE_V1, type EditingLayerDisclosureV1, type EditingLayerPageNavigationV1 } from "./editingLayerNavigationV1";
import { formatTime, makeId } from "../lib/format";
import { EasyIcon } from "./easy/easyIcons";
import { TrackNameEditorV1, TrackQuickTogglesV1 } from "./TrackHeaderControlsV1";
import { clipLayerLabelV1 } from "./clipLayerNamesV1";
import { clipBlendModeLabelV1 } from "./clipBlendModesV1";
import { planLayerTrackMoveV1 } from "../application/layerTrackReorderV1";

export { EDITING_LAYER_PAGE_SIZE_V1 } from "./editingLayerNavigationV1";
export function renderEditingLayerPageV1<T>({ items, render, start, onNavigate }: {
  items: readonly T[]; render: (item: T) => ReactNode; start: number; onNavigate: (offset: number) => void;
}) {
  return <>{items.slice(start, start + EDITING_LAYER_PAGE_SIZE_V1).map(render)}
    {items.length > EDITING_LAYER_PAGE_SIZE_V1 && <div className="layer-pages">
      <button type="button" disabled={start === 0} onClick={() => onNavigate(start - EDITING_LAYER_PAGE_SIZE_V1)}>{pageText("上一頁")}</button>
      <small>{start + 1}–{Math.min(start + EDITING_LAYER_PAGE_SIZE_V1, items.length)} / {items.length}</small>
      <button type="button" disabled={start + EDITING_LAYER_PAGE_SIZE_V1 >= items.length} onClick={() => onNavigate(start + EDITING_LAYER_PAGE_SIZE_V1)}>{pageText("下一頁")}</button>
    </div>}</>;
}
export function LayerPageV1<T extends { id: string }>({ items, selectedId, render }: { items: readonly T[]; selectedId?: string; render: (item: T) => ReactNode }) {
  useI18n();
  const selectedIndex = useMemo(() => selectedId === undefined ? -1 : items.findIndex(item => item.id === selectedId), [items, selectedId]);
  const follow = editingLayerPageV1(items.length, selectedId, selectedIndex);
  const [navigation, setNavigation] = useState<EditingLayerPageNavigationV1 & { token: object }>(() => ({ anchor: follow.anchor, offset: follow.start, token: {} }));
  const page = editingLayerPageV1(items.length, selectedId, selectedIndex, navigation);
  const activeNavigation = navigation.anchor === page.anchor ? navigation : { anchor: page.anchor, offset: page.start, token: {} };
  // Adjust only this component's UI state when selection changes, including A->B->A. No project/DOM effect.
  if (activeNavigation !== navigation) setNavigation(activeNavigation);
  return renderEditingLayerPageV1({ items, render, start: page.start,
    onNavigate: offset => setNavigation(current => current.token === activeNavigation.token ? { ...current, offset } : current) });
}

/** Track drag in the 圖層 panel (pointer events: the desktop shell owns native file drops, so no HTML drag and drop). */
export function createLayerTrackDragV1(host: { tracks: () => readonly TimelineTrack[]; onTarget: (trackId?: string) => void;
  onDrop: (trackId: string, targetTrackId: string) => void; hit: (x: number, y: number) => string | undefined }) {
  let held: { trackId: string; pointerId: number; target?: string } | undefined;
  const end = (drop: boolean) => {
    const current = held; held = undefined; host.onTarget(undefined);
    if (drop && current?.target && current.target !== current.trackId) host.onDrop(current.trackId, current.target);
  };
  return {
    get dragging() { return held?.trackId; },
    down(trackId: string, pointerId: number, button = 0) {
      const track = host.tracks().find(item => item.id === trackId);
      if (button !== 0 || !track || track.locked) return false;
      held = { trackId, pointerId };
      return true;
    },
    move(pointerId: number, x: number, y: number) {
      if (!held || held.pointerId !== pointerId) return;
      const id = host.hit(x, y), source = host.tracks().find(item => item.id === held!.trackId);
      const target = id ? host.tracks().find(item => item.id === id) : undefined;
      held.target = target && source && target.kind === source.kind && target.id !== source.id ? target.id : undefined;
      host.onTarget(held.target);
    },
    up(pointerId: number) { if (held?.pointerId === pointerId) end(true); },
    cancel: () => end(false),
  };
}

/** The project is the sole layer authority. This view creates no parallel layer graph or playback clock. */
export const EditingLayerStackV1 = memo(function EditingLayerStackV1({ project, selection, onSelect, onCommand, onStatus, onAddAdjustmentLayer, adjustmentLayerReady = false }: {
  project: EditProject; selection?: EditingLayerSelectionV1;
  onSelect: (selection: EditingLayerSelectionV1) => void;
  onCommand: (command: EditorCommand, message: string) => unknown;
  /** Says why a drag reorder was refused (a locked layer, another kind). */
  onStatus?: (message: string) => void;
  /** ＋ 調整圖層 over the marked I/O range or the selected clip; enabled when there is one. */
  onAddAdjustmentLayer?: () => void; adjustmentLayerReady?: boolean;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const tracksRef = useRef(project.tracks); tracksRef.current = project.tracks;
  const commandRef = useRef(onCommand); commandRef.current = onCommand;
  const statusRef = useRef(onStatus); statusRef.current = onStatus;
  const [trackDrag] = useState(() => createLayerTrackDragV1({ tracks: () => tracksRef.current, onTarget: setDropTarget,
    hit: (x, y) => (typeof document === "undefined" ? undefined : document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-layer-track-id]")?.dataset.layerTrackId),
    onDrop: (trackId, targetTrackId) => {
      try { const command = planLayerTrackMoveV1({ tracks: tracksRef.current }, trackId, targetTrackId); if (command) commandRef.current(command, pageText("已移動圖層順序")); }
      catch (error) { statusRef.current?.(pageText(error instanceof Error ? error.message : String(error))); }
    } }));
  const grip = (track: TimelineTrack) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!trackDrag.down(track.id, event.pointerId, event.button)) return;
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* detached */ }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => trackDrag.move(event.pointerId, event.clientX, event.clientY),
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => trackDrag.up(event.pointerId),
    onPointerCancel: () => trackDrag.cancel(),
    onLostPointerCapture: () => { if (trackDrag.dragging) trackDrag.cancel(); },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => { if (event.key === "Escape" && trackDrag.dragging) { event.preventDefault(); trackDrag.cancel(); } },
  });
  const clipRow = (clip: TimelineClip, track: TimelineTrack) => {
    const label = clipLayerLabelV1(project, clip, t, { asset: assets.get(clip.assetId), track }), enabled = clip.layer?.enabled ?? true, blend = clip.layer?.blendMode ?? "normal";
    const opacity = Math.round(Math.max(0, Math.min(1, clip.transform.opacity)) * 100);
    return <div className="layer-row layer-clip-row" key={clip.id} data-layer-enabled={enabled}>
      {pick("clip", clip.id, label.name, formatTime(clip.timelineStart))}
      {blend !== "normal" && (clip.layer?.role ?? "content") === "content" && <small className="layer-badge" title={t("混合模式")}>{t(clipBlendModeLabelV1(blend))}</small>}
      {opacity < 100 && <small className="layer-badge" title={t("不透明度")}>{opacity}%</small>}
      {track.kind === "video" && <button type="button" className="layer-eye" data-testid={`layer-clip-enabled-${clip.id}`} aria-pressed={!enabled} disabled={track.locked}
        aria-label={t("{value0} 隱藏這個圖層", { value0: label.name })} title={t(track.locked ? "軌道已鎖定，先解鎖才能修改。" : enabled ? "隱藏這個圖層（只這一段，不刪除）" : "已隱藏：按一下顯示這個圖層")}
        onClick={() => onCommand({ type: "set_clip_layer", clipId: clip.id, patch: { enabled: !enabled } }, t(enabled ? "已隱藏這個圖層，可復原。" : "已顯示這個圖層，可復原。"))}><EasyIcon name={enabled ? "eye" : "eye-off"} /></button>}
      {track.locked && <span className="layer-locked" title={t("軌道已鎖定")} aria-label={t("軌道已鎖定")}><EasyIcon name="lock" /></span>}
    </div>;
  };
  const index = useMemo(() => createEditingTrackIndexV1(project.tracks), [project.tracks]);
  const assets = useMemo(() => new Map(project.assets.map(asset => [asset.id, asset])), [project.assets]);
  const location = useMemo(() => editingLayerLocationV1(index, project.captions, project.motionGraphics, selection),
    [index, project.captions, project.motionGraphics, selection?.kind, selection?.id]);
  const selectionKey = JSON.stringify(location ? [location.kind, location.id, location.trackId ?? null, location.index] : []);
  const [view, setView] = useState<{ selectionKey: string; token: object; expanded: Record<string, EditingLayerDisclosureV1> }>(() => ({ selectionKey, token: {}, expanded: {} }));
  const activeView = view.selectionKey === selectionKey ? view : { ...view, selectionKey, token: {} };
  if (activeView !== view) setView(activeView);
  const selectedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectedRow.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeView.token]);
  const isOpen = (id: string, selected: boolean) => editingLayerDisclosureOpenV1(activeView.expanded[id], activeView.token, selected);
  const toggle = (id: string, open: boolean) => setView(current => current.token === activeView.token
    ? { ...current, expanded: { ...current.expanded, [id]: { anchor: activeView.token, open } } } : current);
  const captionsKey = JSON.stringify(["group", "caption"]), graphicsKey = JSON.stringify(["group", "graphic"]);
  const captionsOpen = isOpen(captionsKey, location?.kind === "caption"), graphicsOpen = isOpen(graphicsKey, location?.kind === "graphic");
  const pick = (kind: EditingLayerSelectionV1["kind"], id: string, name: string, detail?: string) => <button type="button" className="layer-pick"
    data-layer-kind={kind} data-layer-id={id} ref={selection?.kind === kind && selection.id === id ? selectedRow : undefined}
    aria-pressed={selection?.kind === kind && selection.id === id} onClick={() => onSelect({ kind, id })}>{detail ? <><span className="layer-pick-name">{name}</span><small className="layer-pick-detail">{detail}</small></> : name}</button>;
  return <section className="editor-layer-stack" aria-label={t("圖層")} data-testid="editing-layer-stack">
    <h2>{t("圖層")}</h2>
    <div className="layer-row layer-add-row">{(["video", "audio"] as const).map(kind => <button type="button" key={kind}
      onClick={() => onCommand({ type: "add_track", track: { id: makeId("layer"), name: t(kind === "video" ? "影像圖層" : "音訊圖層"), kind, locked: false, muted: false, clips: [] } }, t("已新增圖層"))}>{t(kind === "video" ? "＋影像圖層" : "＋音訊圖層")}</button>)}
      {onAddAdjustmentLayer && <button type="button" data-testid="layer-add-adjustment" disabled={!adjustmentLayerReady} onClick={onAddAdjustmentLayer}
        title={t(adjustmentLayerReady ? "在選取的片段（或 I／O 範圍）上方加一層調整圖層：調色會套用到下方所有畫面" : "先在時間軸選一段片段，或按 I／O 標出範圍，再加入調整圖層。")}><EasyIcon name="adjust" />{t("＋調整圖層")}</button>}</div>
    <LayerPageV1 key={`tracks:${project.id}`} items={index.displayTracks} selectedId={location?.trackId} render={track => {
      const up = index.adjacentCommand(track.id, "up"), down = index.adjacentCommand(track.id, "down");
      const disclosureId = JSON.stringify(["track", track.id]), trackOpen = isOpen(disclosureId, location?.trackId === track.id);
      return <div key={track.id} className="layer-track" data-layer-track-id={track.id} data-drop-target={dropTarget === track.id || undefined}
        data-dragging={trackDrag.dragging === track.id || undefined}>
      <div className="layer-row">
        <button type="button" className="layer-grip" data-testid={`layer-grip-${track.id}`} disabled={track.locked} {...grip(track)}
          aria-label={t("拖曳 {value0} 調整上下順序", { value0: track.name })} title={t(track.locked ? "圖層已鎖定，請先解鎖。" : "拖曳到其他圖層上調整上下順序（也可以按 ↑ ↓）")}><EasyIcon name="grip" /></button>
        {renaming === track.id
          ? <TrackNameEditorV1 name={track.name} label={t("{value0} 軌道名稱", { value0: track.name })} onDone={() => setRenaming(undefined)}
            onCommit={name => onCommand({ type: "rename_track", trackId: track.id, name }, t("軌道已重新命名為「{name}」。", { name }))} />
          : <button type="button" className="layer-pick" aria-expanded={trackOpen} title={t("雙擊重新命名")}
            onClick={() => toggle(disclosureId, !trackOpen)} onDoubleClick={() => setRenaming(track.id)}>
            {trackOpen ? "▾" : "▸"} {track.name} <small>({track.clips.length})</small>
          </button>}
      </div><div className="layer-row layer-actions">
        <TrackQuickTogglesV1 track={track}
          onToggleHidden={id => onCommand({ type: "toggle_track_hidden", trackId: id }, t("已切換圖層顯示"))}
          onToggleMute={id => onCommand({ type: "toggle_track_mute", trackId: id }, t("已切換軌道靜音"))}
          onToggleSolo={id => onCommand({ type: "set_track_solo", trackId: id, solo: !track.solo }, t(track.solo ? "已取消軌道獨奏。" : "已獨奏這條軌道。"))}
          onToggleLock={id => onCommand({ type: "toggle_track_lock", trackId: id }, t("已切換圖層鎖定"))} />
        <button type="button" className="layer-rename" aria-label={t("重新命名 {value0}", { value0: track.name })} title={t("重新命名（也可以雙擊名稱）")}
          onClick={() => setRenaming(track.id)}><EasyIcon name="pencil" /></button>
        <button type="button" aria-label={t("圖層上移")} title={t("圖層上移")} disabled={!up} onClick={() => { if (up) onCommand(up, t("已移動圖層順序")); }}>↑</button>
        <button type="button" aria-label={t("圖層下移")} title={t("圖層下移")} disabled={!down} onClick={() => { if (down) onCommand(down, t("已移動圖層順序")); }}>↓</button>
      </div>
      {trackOpen && <div className="layer-children"><LayerPageV1 key={track.id} items={track.clips} selectedId={location?.trackId === track.id && selection?.kind === "clip" ? selection.id : undefined}
        render={clip => clipRow(clip, track)} /></div>}
    </div>; }} />
    <details open={captionsOpen}><summary onClick={event => { event.preventDefault(); toggle(captionsKey, !captionsOpen); }}>{t("文字")} ({project.captions.length})</summary><LayerPageV1 key={`captions:${project.id}`} items={project.captions} selectedId={selection?.kind === "caption" ? selection.id : undefined}
      render={caption => <div className="layer-row" key={caption.id}>{pick("caption", caption.id, caption.text || t("文字"))}</div>} /></details>
    <details open={graphicsOpen}><summary onClick={event => { event.preventDefault(); toggle(graphicsKey, !graphicsOpen); }}>{t("動態圖層")} ({project.motionGraphics.length})</summary><LayerPageV1 key={`graphics:${project.id}`} items={project.motionGraphics} selectedId={selection?.kind === "graphic" ? selection.id : undefined}
      render={graphic => <div className="layer-row" key={graphic.id}>{pick("graphic", graphic.id, graphic.name)}</div>} /></details>
  </section>;
});
