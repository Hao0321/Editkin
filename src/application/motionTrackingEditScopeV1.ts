import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { TimelineSelection } from "./timelineSelection";
import type { ProjectSession, ProjectTask } from "./projectSession";
import type { TrackingMode } from "../ui/editorShellTypes";
import { findClip } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE, trackOfClip } from "../domain/trackLock";

export const MOTION_TRACKING_EDIT_STALE_V1 = "追蹤目標已變更，請重新選取片段並框選主體。";
interface Host {
  session: ProjectSession;
  getSelection: () => TimelineSelection;
  subscribeSelection: (listener: () => void) => () => void;
  onStatus: (message: string) => void;
}
interface Scope { task: ProjectTask; selection: TimelineSelection; clipId: string }
interface ModeScope extends Scope { attachment: object }
export interface MotionTrackingEditContextV1 { project: EditProject; clip: TimelineClip; asset: MediaAsset }

/** Transient UI authority only. The original session/selection/commands remain the sole content owners. */
export function createMotionTrackingEditScopeV1(host: Host) {
  const modes = new WeakMap<TrackingMode, ModeScope>();
  let attachment: object | undefined;
  const capture = (project: EditProject, clipId?: string): Scope => {
    const selection = host.getSelection();
    if (!clipId || selection.primaryClipId !== clipId || project !== host.session.getSnapshot().history.present) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
    return { task: host.session.beginTask(project), selection, clipId };
  };
  const context = (scope: Scope): MotionTrackingEditContextV1 => {
    if (!attachment || !scope.task.isCurrent() || host.getSelection() !== scope.selection) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
    const project = host.session.getSnapshot().history.present, clip = findClip(project, scope.clipId);
    const asset = project.assets.find(item => item.id === clip.assetId);
    if (!asset || asset.kind !== "video" || asset.compositionId) throw Error("動態追蹤需要桌面版影片素材。");
    if (trackOfClip(project, clip.id)?.locked) throw Error(TRACK_LOCKED_MESSAGE);
    return { project, clip, asset };
  };
  const trackContext = (selected: MotionTrackingEditContextV1, trackId: string) => {
    const track = selected.project.motionTracks.find(item => item.id === trackId);
    if (!track || track.clipId !== selected.clip.id) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
    return track;
  };
  const read = (mode?: TrackingMode): MotionTrackingEditContextV1 | undefined => {
    if (!mode) return undefined;
    const scope = modes.get(mode);
    if (!scope || scope.attachment !== attachment) return undefined;
    try {
      const selected = context(scope);
      if (mode.kind === "correct") {
        if (!mode.trackId) return undefined;
        trackContext(selected, mode.trackId);
      }
      if (mode.kind === "podcast" && mode.role === "guest") {
        if (!mode.hostTrack) return undefined;
        trackContext(selected, mode.hostTrack.id);
      }
      return selected;
    } catch { return undefined; }
  };
  return {
    read,
    retire(mode?: TrackingMode): void { if (mode) modes.delete(mode); },
    captureMode(mode: TrackingMode): TrackingMode | undefined {
      try {
        const project = host.session.getSnapshot().history.present, scope = capture(project, host.getSelection().primaryClipId);
        const selected = context(scope);
        const owner = attachment; if (!owner) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
        if (mode.kind === "correct") {
          if (!mode.trackId) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
          trackContext(selected, mode.trackId);
        }
        let next = { ...mode };
        if (mode.kind === "podcast" && mode.role === "guest") {
          if (!mode.hostTrack) throw Error("主持人追蹤資料遺失，請重新開始雙人物導播");
          // Use the canonical committed host, not a caller's stale copy of its points.
          next = { ...mode, hostTrack: trackContext(selected, mode.hostTrack.id) };
        }
        const bound = Object.freeze(next);
        modes.set(bound, { ...scope, attachment: owner }); return bound;
      } catch (error) { host.onStatus(error instanceof Error ? error.message : MOTION_TRACKING_EDIT_STALE_V1); return undefined; }
    },
    renderGuard(project: EditProject, clipId?: string): (trackId?: string) => boolean {
      let scope: Scope | undefined;
      try { scope = capture(project, clipId); } catch { /* A missing/stale selection is an unavailable action, not another clip. */ }
      return (trackId?: string) => {
        try {
          if (!scope) throw Error(MOTION_TRACKING_EDIT_STALE_V1);
          const selected = context(scope);
          if (trackId !== undefined) trackContext(selected, trackId);
          return true;
        } catch (error) { host.onStatus(error instanceof Error ? error.message : MOTION_TRACKING_EDIT_STALE_V1); return false; }
      };
    },
    attach(getMode: () => TrackingMode | undefined, onInvalidated: () => void): () => void {
      const token = {}; attachment = token;
      const reconcile = () => {
        if (attachment !== token) return;
        const mode = getMode();
        if (mode && !read(mode)) { modes.delete(mode); onInvalidated(); }
      };
      const unsubscribeSelection = host.subscribeSelection(reconcile), unsubscribeProject = host.session.subscribe(reconcile);
      reconcile();
      return () => {
        unsubscribeSelection(); unsubscribeProject();
        if (attachment !== token) return;
        const mode = getMode(); if (mode) modes.delete(mode);
        attachment = undefined;
      };
    },
  };
}
