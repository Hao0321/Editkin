import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { translateUi as pageText, useI18n } from "./i18n/interfacePreferences";
import type { EditingLayerSelectionV1 } from "./editingWorkspaceV1";
import { createEditingTrackIndexV1, editingLayerDisclosureOpenV1, editingLayerLocationV1, editingLayerPageV1,
  EDITING_LAYER_PAGE_SIZE_V1, type EditingLayerDisclosureV1, type EditingLayerPageNavigationV1 } from "./editingLayerNavigationV1";
import { makeId } from "../lib/format";

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

/** The project is the sole layer authority. This view creates no parallel layer graph or playback clock. */
export const EditingLayerStackV1 = memo(function EditingLayerStackV1({ project, selection, onSelect, onCommand }: {
  project: EditProject; selection?: EditingLayerSelectionV1;
  onSelect: (selection: EditingLayerSelectionV1) => void;
  onCommand: (command: EditorCommand, message: string) => unknown;
}) {
  const { t } = useI18n();
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
  const pick = (kind: EditingLayerSelectionV1["kind"], id: string, name: string) => <button type="button" className="layer-pick"
    data-layer-kind={kind} data-layer-id={id} ref={selection?.kind === kind && selection.id === id ? selectedRow : undefined}
    aria-pressed={selection?.kind === kind && selection.id === id} onClick={() => onSelect({ kind, id })}>{name}</button>;
  return <section className="editor-layer-stack" aria-label={t("圖層")} data-testid="editing-layer-stack">
    <h2>{t("圖層")}</h2>
    <div className="layer-row">{(["video", "audio"] as const).map(kind => <button type="button" key={kind}
      onClick={() => onCommand({ type: "add_track", track: { id: makeId("layer"), name: t(kind === "video" ? "影像圖層" : "音訊圖層"), kind, locked: false, muted: false, clips: [] } }, t("已新增圖層"))}>{t(kind === "video" ? "＋影像圖層" : "＋音訊圖層")}</button>)}</div>
    <LayerPageV1 key={`tracks:${project.id}`} items={index.displayTracks} selectedId={location?.trackId} render={track => {
      const up = index.adjacentCommand(track.id, "up"), down = index.adjacentCommand(track.id, "down");
      const disclosureId = JSON.stringify(["track", track.id]), trackOpen = isOpen(disclosureId, location?.trackId === track.id);
      return <div key={track.id}>
      <div className="layer-row">
        <button type="button" className="layer-pick" aria-expanded={trackOpen}
          onClick={() => toggle(disclosureId, !trackOpen)}>
          {trackOpen ? "▾" : "▸"} {track.name} <small>({track.clips.length})</small>
        </button>
      </div><div className="layer-row layer-actions">
        {track.kind === "video" && <button type="button" aria-label={t("顯示畫面")} aria-pressed={!track.hidden}
          onClick={() => onCommand({ type: "toggle_track_hidden", trackId: track.id }, t("已切換圖層顯示"))}>{track.hidden ? "○" : "◉"}</button>}
        {track.kind === "audio" && <button type="button" aria-label={t("靜音")} aria-pressed={track.muted}
          onClick={() => onCommand({ type: "toggle_track_mute", trackId: track.id }, t("已切換軌道靜音"))}>M</button>}
        <button type="button" aria-label={t("鎖定圖層")} aria-pressed={track.locked}
          onClick={() => onCommand({ type: "toggle_track_lock", trackId: track.id }, t("已切換圖層鎖定"))}>{track.locked ? "●" : "◇"}</button>
        <button type="button" aria-label={t("圖層上移")} disabled={!up} onClick={() => { if (up) onCommand(up, t("已移動圖層順序")); }}>↑</button>
        <button type="button" aria-label={t("圖層下移")} disabled={!down} onClick={() => { if (down) onCommand(down, t("已移動圖層順序")); }}>↓</button>
      </div>
      {trackOpen && <div className="layer-children"><LayerPageV1 key={track.id} items={track.clips} selectedId={location?.trackId === track.id && selection?.kind === "clip" ? selection.id : undefined}
        render={clip => <div className="layer-row" key={clip.id}>{pick("clip", clip.id,
          assets.get(clip.assetId)?.name ?? t("片段"))}</div>} /></div>}
    </div>; }} />
    <details open={captionsOpen}><summary onClick={event => { event.preventDefault(); toggle(captionsKey, !captionsOpen); }}>{t("文字")} ({project.captions.length})</summary><LayerPageV1 key={`captions:${project.id}`} items={project.captions} selectedId={selection?.kind === "caption" ? selection.id : undefined}
      render={caption => <div className="layer-row" key={caption.id}>{pick("caption", caption.id, caption.text || t("文字"))}</div>} /></details>
    <details open={graphicsOpen}><summary onClick={event => { event.preventDefault(); toggle(graphicsKey, !graphicsOpen); }}>{t("動態圖層")} ({project.motionGraphics.length})</summary><LayerPageV1 key={`graphics:${project.id}`} items={project.motionGraphics} selectedId={selection?.kind === "graphic" ? selection.id : undefined}
      render={graphic => <div className="layer-row" key={graphic.id}>{pick("graphic", graphic.id, graphic.name)}</div>} /></details>
  </section>;
});
