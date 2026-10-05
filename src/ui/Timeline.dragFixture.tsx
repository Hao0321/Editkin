/* Local source-UI diagnostic only. These declared fixture assets are not production media evidence. */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createEmptyProject, migrateProject, projectDuration, validateProject } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commands";
import { createHistory, dispatchCommandSafely, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { projectSchema } from "../domain/schema";
import { planTimelineAssetInsert, planTimelineClipMove } from "../application/timelinePlacement";
import { Timeline } from "./Timeline";
import { MediaBin } from "./MediaBin";
import "../styles.css";

function initial(fps: number) {
  const project = createEmptyProject("Timeline source UI diagnostic", { id: "owned-timeline-diagnostic", fps });
  project.assets = [{ id: "fixture-video", name: "虛構操作素材", uri: "fixture-only.mp4", kind: "video", duration: 20, width: 1920, height: 1080 },
    { id: "fractional-video", name: "2.017 秒邊界素材（診斷）", uri: "fractional-fixture-only.mp4", kind: "video", duration: 2.017, width: 1920, height: 1080 }];
  const clip = (id: string, start: number, duration: number) => ({ id, assetId: "fixture-video", trackId: "video-main", timelineStart: start, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  project.tracks[0].clips = [clip("drag-a", 1, 3), clip("drag-b", 4, 3)];
  project.tracks.push({ id: "video-second", name: "第二畫面", kind: "video", locked: false, muted: false, clips: [] });
  return validateProject(project);
}

function Fixture() {
  const [history, setHistory] = useState(() => createHistory(initial(30)));
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [draggingAssetId, setDraggingAssetId] = useState<string>();
  const [playhead, setPlayhead] = useState(0);
  const [status, setStatus] = useState("未執行");
  const [saved, setSaved] = useState<string>();
  const project = history.present;
  const sequence = useRef(0);
  const makeId = (prefix: string) => `${prefix}-fixture-${++sequence.current}`;
  const command = (value: EditorCommand) => {
    const result = dispatchCommandSafely(history, value, makeId("command"));
    if (result.error) { setStatus(result.error); return false; }
    setHistory(result.state); setStatus("已提交"); return true;
  };
  const insert = (assetId: string, trackId: string, start: number) => {
    try { const plan = planTimelineAssetInsert(project, assetId, trackId, start, makeId("clip"), makeId); return command(plan.command); }
    catch (error) { setStatus(String(error)); return false; }
  };
  const reset = (fps: number) => { setHistory(createHistory(initial(fps))); setSelectedClipId(undefined); setPlayhead(0); setSaved(undefined); setStatus("未執行"); };
  return <main className="app-shell" style={{ display: "block", height: "100vh", overflow: "auto", padding: 12 }}>
    <h2>時間軸診斷：本機 source／虛構資料，非已安裝產品驗收</h2>
    <div style={{ display: "flex", gap: 12 }}>
      <button onClick={() => reset(30)}>重設 30fps</button><button onClick={() => reset(60)}>重設 60fps</button>
      <button onClick={() => setHistory(undo)}>復原一次</button>
      <button onClick={() => { setSaved(JSON.stringify(project)); setStatus("已保存診斷 JSON"); }}>存檔</button>
      <button disabled={!saved} onClick={() => { setHistory(createHistory(validateProject(projectSchema.parse(migrateProject(JSON.parse(saved!)))))); setStatus("已重開診斷 JSON"); }}>重開</button>
      <button onClick={() => command({ type: "toggle_track_lock", trackId: "video-second" })}>切換第二軌鎖定</button>
    </div>
    <output data-testid="fixture-status">{status}</output>
    <pre data-testid="fixture-state">{JSON.stringify({ fps: project.fps, history: history.past.length, clips: project.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, trackId: clip.trackId, frame: Math.round(clip.timelineStart * project.fps), duration: clip.duration })) }, null, 2)}</pre>
    <div style={{ display: "grid", gridTemplateColumns: "300px minmax(500px, 1fr)", gap: 12 }}>
      <div style={{ height: 260 }}><MediaBin assets={project.assets} runtimeUrls={{}} onImport={() => undefined}
        onAssetDragStart={setDraggingAssetId} onAssetDragEnd={() => setDraggingAssetId(undefined)}
        onAddAssetToTimeline={assetId => { insert(assetId, "video-second", 8); }} /></div>
      <Timeline project={project} duration={projectDuration(project)} playhead={playhead} selectedClipId={selectedClipId} runtimeUrls={{}} draggingAssetId={draggingAssetId}
        onSelect={setSelectedClipId} onSelectCaption={() => undefined} onSeek={setPlayhead} onInsertAsset={insert}
        onMoveClip={(clipId, start, trackId) => { try { return command(planTimelineClipMove(project, clipId, trackId, start, makeId).command); } catch (error) { setStatus(String(error)); return false; } }}
        onMoveCaption={() => false} onTrimClip={() => undefined} onTrimCaption={() => undefined} onAddCaption={() => undefined} onAddTrack={() => undefined}
        onRenameTrack={() => undefined} onToggleTrackLock={trackId => { command({ type: "toggle_track_lock", trackId }); }}
        onDeleteTrack={() => undefined} onMakePictureInPicture={() => undefined} onPrecompose={() => undefined} onToggleMute={() => undefined} onSplit={() => undefined} onDelete={() => undefined} />
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
