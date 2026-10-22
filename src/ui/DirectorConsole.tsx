import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorCommand } from "../domain/commands";
import type { AestheticArtifactBinding, DirectorMarkerKind, DirectorReviewState, EditProject, TimelineClip } from "../domain/types";
import { formatTime } from "../lib/format";
import { projectDuration } from "../domain/editGraph";
import { AestheticReviewPanel } from "./AestheticReviewPanel";
import { clampProjectSeek } from "./playbackTiming";
import { useNativeWheelScroll } from "./wheelScroll";
import "./directorConsole.css";

interface DirectorConsoleProps {
  docked?: boolean;
  runtimeUrls?: Record<string, string>;
  project: EditProject;
  playhead: number;
  currentArtifact?: AestheticArtifactBinding;
  onSeek: (time: number) => void;
  onCommand: (command: EditorCommand, message?: string) => void;
  onClose: () => void;
}

export type DirectorConsoleView = "overview" | "notes" | "aesthetic";

/** Director rhythm review is a picture edit view. Audio-only material is never a visual cut. */
export function directorVisualClips(project: EditProject): TimelineClip[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  return project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip) => assets.get(clip.assetId)?.kind !== "audio")
    .sort((left, right) => left.timelineStart - right.timelineStart || left.id.localeCompare(right.id));
}

/**
 * Keeps every visual segment under the playhead, even when a long shot began
 * outside the nearby-cut window. Remaining slots are chronological start cuts.
 */
export function nearbyDirectorVisualCuts(
  visualClips: readonly TimelineClip[],
  playhead: number,
  radiusSeconds = 20,
  limit = 80,
): TimelineClip[] {
  const ordered = [...visualClips].sort((left, right) => left.timelineStart - right.timelineStart || left.id.localeCompare(right.id));
  const active = ordered.filter((clip) => playhead >= clip.timelineStart && playhead < clip.timelineStart + clip.duration);
  const activeIds = new Set(active.map((clip) => clip.id));
  const nearby = ordered.filter((clip) => !activeIds.has(clip.id) && Math.abs(clip.timelineStart - playhead) <= radiusSeconds);
  const remaining = Math.max(0, limit - active.length);
  return [...active, ...nearby.slice(0, remaining)]
    .sort((left, right) => left.timelineStart - right.timelineStart || left.id.localeCompare(right.id));
}

const STATE_LABELS: Record<DirectorReviewState, string> = {
  draft: "草稿", reviewing: "導演審片中", changes_requested: "需要修改", ready_for_hao_review: "待最終畫面檢查",
};

interface DirectorTabsProps {
  view: DirectorConsoleView;
  openCount: number;
  onViewChange: (view: DirectorConsoleView) => void;
}

export function DirectorTabs({ view, openCount, onViewChange }: DirectorTabsProps) {
  useI18n();
  return <nav className="director-tabs" role="tablist" aria-label={uiText("導演台工作區")}>
    <button id="director-tab-overview" type="button" role="tab" aria-selected={view === "overview"} aria-controls="director-panel-overview" onClick={() => onViewChange("overview")}>{uiText("節奏總覽")}</button>
    <button id="director-tab-notes" type="button" role="tab" aria-selected={view === "notes"} aria-controls="director-panel-notes" onClick={() => onViewChange("notes")}>{uiText("時間碼註記")}{openCount > 0 && <> <b>{openCount}</b></>}</button>
    <button id="director-tab-aesthetic" type="button" role="tab" aria-selected={view === "aesthetic"} aria-controls="director-panel-aesthetic" onClick={() => onViewChange("aesthetic")}>{uiText("美感評分")}</button>
  </nav>;
}

interface DirectorCutMapProps {
  clips: readonly TimelineClip[];
  playhead: number;
  onSeek: (time: number) => void;
  media?: ReadonlyMap<string, { name: string; thumbnail?: string }>;
}

export function DirectorCutMap({ clips, playhead, onSeek, media }: DirectorCutMapProps) {
  useI18n();
  if (clips.length === 0) return <p className="director-empty">{uiText("目前播放頭附近沒有視覺片段。")}</p>;
  return <div className="cut-map-track" data-testid="director-cut-map">{clips.map((clip) => <button
    type="button"
    key={clip.id}
    data-clip-id={clip.id}
    style={{ flexGrow: Math.min(6, Math.max(1, clip.duration)) }}
    className={playhead >= clip.timelineStart && playhead < clip.timelineStart + clip.duration ? "active" : ""}
    onClick={() => onSeek(clip.timelineStart)}
    title={`${media?.get(clip.assetId)?.name ?? clip.id} · ${formatTime(clip.duration)}`}
    aria-label={uiText("{value0} 的視覺剪點", { value0: formatTime(clip.timelineStart) })}
  >{media?.get(clip.assetId)?.thumbnail && <img src={media.get(clip.assetId)!.thumbnail} alt="" loading="lazy" decoding="async" />}
    <strong>{media?.get(clip.assetId)?.name ?? uiText("視覺片段")}</strong><span>{formatTime(clip.timelineStart)}</span><small>{clip.duration.toFixed(1)} {uiText("秒")}</small></button>)}</div>;
}

export function DirectorConsole({ project, playhead, currentArtifact, onSeek: requestSeek, onCommand, onClose, docked = false, runtimeUrls = {} }: DirectorConsoleProps) {
  useI18n();
  // A marker can sit past a trimmed end; the playhead still stops at the real end.
  const onSeek = (time: number) => requestSeek(clampProjectSeek(time, projectDuration(project)));
  const [view, setView] = useState<DirectorConsoleView>("overview");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<DirectorMarkerKind>("note");
  const dialog = useRef<HTMLElement>(null);
  useNativeWheelScroll(dialog, "vertical", view);
  const media = useMemo(() => new Map(project.assets.map(asset => [asset.id, { name: asset.name, thumbnail: runtimeUrls[`${asset.id}:thumbnail`] ?? (asset.kind === "image" ? runtimeUrls[asset.id] : undefined) }])), [project.assets, runtimeUrls]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>(".modal-close")?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  const allClips = useMemo(() => project.tracks.flatMap((track) => track.clips), [project.tracks]);
  const visualClips = useMemo(() => directorVisualClips(project), [project.assets, project.tracks]);
  const nearbyCuts = useMemo(() => nearbyDirectorVisualCuts(visualClips, playhead), [playhead, visualClips]);
  const openCount = project.director.markers.filter((marker) => marker.status === "open").length;
  const aesthetic = project.aestheticSystem;
  const timelineDurationFrames = Math.max(1, Math.ceil(Math.max(
    allClips.reduce((end, clip) => Math.max(end, clip.timelineStart + clip.duration), 0),
    project.captions.reduce((end, cue) => Math.max(end, cue.start + cue.duration), 0),
  ) * project.fps));
  const addMarker = () => {
    const value = title.trim();
    if (!value) return;
    const id = `director-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    onCommand({ type: "add_director_marker", marker: { id, time: playhead, title: value, note: note.trim(), kind, status: "open", createdAt: new Date().toISOString() } }, `已在 ${formatTime(playhead)} 加入導演註記。`);
    setTitle("");
    setNote("");
  };
  return <div className={docked ? "director-dock" : "modal-backdrop director-backdrop"} role="presentation">
    <section ref={dialog} className="director-console" role={docked ? "region" : "dialog"} aria-modal={docked ? undefined : true} aria-label={uiText("導演台")} data-testid="director-console" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
      if (docked || event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><div><span className="eyebrow">{uiText("審片工作區")}</span><h2>{uiText("導演台")}</h2><p>{docked ? uiText("邊播放、邊標記；點剪點即可看對應畫面。") : uiText("先看整體節奏，再處理時間碼註記與成片美感。")}</p></div><button type="button" className="modal-close" onClick={onClose} aria-label={uiText("關閉導演台")}>×</button></header>
      <div className="director-summary"><div><span>{uiText("目前播放頭")}</span><strong>{formatTime(playhead)}</strong></div><div><span>{uiText("視覺片段")}</span><strong data-testid="director-visual-segment-count">{visualClips.length}</strong></div><div><span>{uiText("待處理")}</span><strong>{openCount}</strong></div><div><span>{uiText("狀態")}</span><strong>{STATE_LABELS[project.director.reviewState]}</strong></div></div>
      <DirectorTabs view={view} openCount={openCount} onViewChange={setView} />
      {view === "overview" && <section id="director-panel-overview" aria-labelledby="director-tab-overview" className="director-workspace director-cut-map" role="tabpanel">
        <div className="section-heading"><div><span className="eyebrow">{uiText("視覺剪點")}</span><h3>{uiText("播放頭前後 20 秒")}</h3></div><small>{uiText("含目前畫面；點一下即可跳轉")}</small></div>
        <DirectorCutMap clips={nearbyCuts} playhead={playhead} onSeek={onSeek} media={media} />
        <div className="director-state-block"><div><strong>{uiText("審片狀態")}</strong><span>{uiText("狀態會存回專案，但不等於發佈認證。")}</span></div><div className="director-state-buttons">{(Object.keys(STATE_LABELS) as DirectorReviewState[]).map((state) => <button type="button" key={state} className={project.director.reviewState === state ? "active" : ""} onClick={() => onCommand({ type: "set_director_review_state", reviewState: state }, `導演台狀態：${STATE_LABELS[state]}`)}>{STATE_LABELS[state]}</button>)}</div></div>
        <p className="director-truth">{uiText("完整成片需依創作者指定的審查方式核對時間碼、動態與畫面；狀態標籤本身不是通過證據。")}</p>
      </section>}
      {view === "notes" && <section id="director-panel-notes" aria-labelledby="director-tab-notes" className="director-workspace director-notes" role="tabpanel">
        <div className="section-heading"><div><span className="eyebrow">{uiText("逐點修改")}</span><h3>{uiText("時間碼註記")}</h3></div><small>{uiText("目前播放頭")}{formatTime(playhead)}</small></div>
        <div className="director-compose"><div><select aria-label={uiText("註記種類")} value={kind} onChange={(event) => setKind(event.target.value as DirectorMarkerKind)}><option value="note">{uiText("導演筆記")}</option><option value="beat">{uiText("敘事節拍")}</option><option value="risk">{uiText("風險")}</option><option value="pickup">{uiText("補拍")}</option></select><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={uiText("這個時間點要改什麼？")} data-testid="director-title-input" /></div><textarea aria-label={uiText("註記細節")} value={note} onChange={(event) => setNote(event.target.value)} placeholder={uiText("原因、具體修改、參考…")} /><button type="button" onClick={addMarker} disabled={!title.trim()} data-testid="director-add-marker">{uiText("＋ 加到")}{formatTime(playhead)}</button></div>
        <div className="director-marker-list">{project.director.markers.length === 0 ? <p className="director-empty">{uiText("還沒有註記。播放到要調整的位置，再加入一筆。")}</p> : project.director.markers.map((marker) => <article key={marker.id} className={`${marker.kind} ${marker.status}`}><button type="button" className="marker-time" onClick={() => onSeek(marker.time)}>{formatTime(marker.time)}</button><div><strong>{marker.title}</strong>{marker.note && <p>{marker.note}</p>}<small>{marker.kind} · {marker.status === "resolved" ? uiText("已處理") : uiText("待處理")}</small></div><button type="button" onClick={() => onCommand({ type: "update_director_marker", markerId: marker.id, patch: { status: marker.status === "open" ? "resolved" : "open" } }, "已更新導演註記狀態。")}>{marker.status === "open" ? uiText("完成") : uiText("重開")}</button><button type="button" className="danger" onClick={() => onCommand({ type: "delete_director_marker", markerId: marker.id }, "已刪除導演註記，可復原。")}>{uiText("刪除")}</button></article>)}</div>
      </section>}
      {view === "aesthetic" && (aesthetic ? <div id="director-panel-aesthetic" aria-labelledby="director-tab-aesthetic" className="director-aesthetic" role="tabpanel"><AestheticReviewPanel key={project.id} system={aesthetic} playhead={playhead} timelineFps={project.fps} timelineDurationFrames={timelineDurationFrames} currentArtifact={currentArtifact} onSeek={onSeek} onReviewChange={(review, message) => onCommand({ type: "set_aesthetic_review", review }, message)} /></div> : <section id="director-panel-aesthetic" aria-labelledby="director-tab-aesthetic" className="director-workspace director-empty" role="tabpanel"><strong>{uiText("這個專案還沒有美感評分設定")}</strong><span>{uiText("先執行自動剪輯或建立美感規格，再回來逐項審查。")}</span></section>)}
    </section>
  </div>;
}
