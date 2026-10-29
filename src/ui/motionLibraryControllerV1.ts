import type { EditorCommand } from "../domain/commandTypes";
import { motionLibraryClipSecondsV1, motionLibraryFrameRateV1 } from "../domain/motionLibraryV1";
import type { EditProject, TimelineClip } from "../domain/types";
import { defaultTransitionFramesV1, findCutV1, findTransitionCutV1, matteTransitionFrameLimitsV1, nearestCutV1, transitionWindowV1,
  type MotionLibraryCutPointV1, type MotionLibraryCutRefV1, type MotionLibraryTransitionWindowV1 } from "./motionLibraryCutsV1";
import { basicTransitionCommandV1, matteTransitionCommandV1, motionLibraryAddCommandV1, motionLibraryUpdateCommandV1, planMotionLibraryClipPlacementV1 } from "./motionLibraryPlanV1";
import { MOTION_LIBRARY_CANCELLED_V1, MOTION_LIBRARY_NATIVE_REQUIRED_V1, type MotionLibraryRenderHostV1, type MotionLibraryRenderedV1 } from "./motionLibraryRenderHostV1";
import type { MotionLibraryJobTargetV1, MotionLibraryTransitionPresetV1, MotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";

/**
 * The Motion Library GUI's actions (PHASE3_INTEGRATION_DESIGN §3–4). Every action that needs a rendered file renders
 * before it dispatches (the host's engine task, with progress and cancel), then dispatches exactly one command, so each
 * add, edit, transition and removal is one Undo step. Nothing is dispatched for a cancelled or failed render, or when
 * another project replaced this one meanwhile.
 */

export interface MotionLibraryControllerDepsV1 {
  getProject(): EditProject;
  runCommand(command: EditorCommand, message?: string): boolean | void;
  setStatus(message: string): void;
  getPlayhead(): number;
  getSelectedClipId(): string | undefined;
  selectClip(clipId: string): void;
  clearClipSelection(): void;
  /** Simple mode: show the panel of what was just picked. */
  revealSelection?(): void;
  mergeRuntimeUrls?(urls: Record<string, string>): void;
  pause?(): void;
  store: MotionLibraryUiStoreV1;
  host(): MotionLibraryRenderHostV1 | undefined;
  makeId(prefix: string): string;
  /** Changes when another project replaces the current one; a render that outlived its project is dropped. */
  sessionToken(): unknown;
}

export interface MotionLibraryKeyboardActionsV1 {
  /** Ctrl+T: the last used transition on the cut nearest the playhead. */
  applyLastTransition(): void;
  /** Delete: removes the selected transition (true), or leaves the key to the editor (false). */
  deleteSelectedTransition(): boolean;
}

interface CatalogFacts { kind: "text" | "transition" | "background"; name: string; defaultSeconds: number }
type CatalogModule = typeof import("../motionLibrary/catalog");
let catalogModule: Promise<CatalogModule> | undefined;
async function catalogFacts(itemId: string): Promise<CatalogFacts> {
  catalogModule ??= import("../motionLibrary/catalog");
  const item = (await catalogModule).getMotionLibraryItem(itemId);
  return { kind: item.kind, name: item.names.zh, defaultSeconds: item.defaultDurationSeconds };
}

const BASIC_LIMITS = (fps: number) => ({ min: 2, max: Math.max(2, Math.round(10 * fps)) });
const presetLabel = (preset: MotionLibraryTransitionPresetV1) => preset.kind === "dissolve" ? "溶接" : preset.kind === "dip" ? "黑場" : preset.itemId;
export const MOTION_LIBRARY_NO_CUT_V1 = "時間軸上還沒有兩段相接的片段可以加轉場；先用剪刀（B）或 Ctrl+B 切開一段影片。";

export function createMotionLibraryControllerV1(deps: MotionLibraryControllerDepsV1) {
  const clipJobs = new Map<string, AbortController>();
  const transitionJobs = new Map<string, AbortController>();

  /** Render with a job entry (progress + cancel). Undefined when cancelled or failed (the status says which). */
  async function render(label: string, itemId: string, target: MotionLibraryJobTargetV1, params: Record<string, unknown>, controller = new AbortController()): Promise<MotionLibraryRenderedV1 | undefined> {
    const host = deps.host();
    if (!host) { deps.setStatus(MOTION_LIBRARY_NATIVE_REQUIRED_V1); return undefined; }
    const project = deps.getProject(), id = deps.makeId("motion-job");
    deps.store.addJob({ id, label, itemId, target, fraction: 0, phase: "cache", cancel: () => controller.abort() });
    deps.setStatus(`正在產生「${label}」…`);
    let lastPublish = 0;
    try {
      return await host.render({ itemId, params, width: project.width, height: project.height, fps: project.fps }, {
        signal: controller.signal,
        onProgress: progress => {
          const now = Date.now();
          if (now - lastPublish < 80 && progress.fraction < 1) return;
          lastPublish = now;
          deps.store.updateJob(id, { fraction: Math.max(0, Math.min(1, progress.fraction)), phase: progress.phase });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted || message === MOTION_LIBRARY_CANCELLED_V1) deps.setStatus(`已取消產生「${label}」，時間軸沒有改變。`);
      else deps.setStatus(`無法產生「${label}」：${message}`);
      return undefined;
    } finally {
      deps.store.removeJob(id);
    }
  }

  function dispatch(command: EditorCommand, message: string, urls?: Readonly<Record<string, string>>): boolean {
    const accepted = deps.runCommand(command, message) !== false;
    if (accepted && urls && Object.keys(urls).length) deps.mergeRuntimeUrls?.({ ...urls });
    return accepted;
  }

  async function addItem(itemId: string, at: { trackId?: string; startFrame?: number; strictTrack?: boolean } = {}): Promise<boolean> {
    let facts: CatalogFacts;
    try { facts = await catalogFacts(itemId); } catch (error) { deps.setStatus(error instanceof Error ? error.message : "找不到這個動態素材。"); return false; }
    if (facts.kind === "transition") return applyTransitionNearPlayhead({ kind: "matte", itemId });
    const before = deps.getProject(), token = deps.sessionToken();
    const startFrame = at.startFrame ?? Math.round(deps.getPlayhead() * before.fps);
    const trackId = at.trackId ?? selectedTrackId(before);
    const durationFrames = Math.max(1, Math.round(facts.defaultSeconds * before.fps));
    // Refuse a drop that can never land (a locked or non-picture track) before spending a render on it.
    try { planMotionLibraryClipPlacementV1(before, { trackId, startFrame, durationFrames, kind: facts.kind, strictTrack: at.strictTrack }, deps.makeId); }
    catch (error) { deps.setStatus(error instanceof Error ? error.message : "這裡不能加入動態素材。"); return false; }
    deps.pause?.();
    const rendered = await render(facts.name, itemId, { kind: "card", itemId }, {});
    if (!rendered || deps.sessionToken() !== token) return false;
    const project = deps.getProject(), clipId = deps.makeId("motion-clip");
    let command: EditorCommand;
    try {
      const placement = planMotionLibraryClipPlacementV1(project, { trackId, startFrame, durationFrames: rendered.frameCount, kind: facts.kind, strictTrack: at.strictTrack }, deps.makeId);
      command = motionLibraryAddCommandV1(project, rendered, placement, clipId);
    } catch (error) { deps.setStatus(error instanceof Error ? error.message : "無法加入動態素材。"); return false; }
    if (!dispatch(command, `已加入「${facts.name}」；可在右側「動態素材」改文字與顏色，一次復原即可移除。`, rendered.previewUrls)) return false;
    deps.store.selectTransition(undefined);
    deps.selectClip(clipId);
    return true;
  }

  function selectedTrackId(project: EditProject): string | undefined {
    const clipId = deps.getSelectedClipId();
    return clipId ? project.tracks.find(track => track.clips.some(clip => clip.id === clipId))?.id : undefined;
  }

  function windowFor(cut: MotionLibraryCutPointV1, preset: MotionLibraryTransitionPresetV1, fps: number, frames?: number): MotionLibraryTransitionWindowV1 | string {
    const limits = preset.kind === "matte" ? matteTransitionFrameLimitsV1(fps) : BASIC_LIMITS(fps);
    const desired = frames ?? (cut.transition ? cut.transition.beforeFrames + cut.transition.afterFrames : defaultTransitionFramesV1(fps));
    const result = transitionWindowV1(cut, desired, limits);
    return "refusal" in result ? result.refusal : result.window;
  }

  /** Apply a transition preset to one cut; keeps the cut's current length when it already has a transition. */
  async function applyTransition(preset: MotionLibraryTransitionPresetV1, ref: MotionLibraryCutRefV1, options: { frames?: number } = {}): Promise<boolean> {
    const project = deps.getProject(), token = deps.sessionToken();
    const cut = findCutV1(project, ref);
    if (!cut) { deps.setStatus("這個剪接點已經不在了，請重新選擇。"); return false; }
    if (cut.locked) { deps.setStatus("這條軌道已鎖定，先解鎖才能加轉場。"); return false; }
    if (!cut.eligible) { deps.setStatus("這兩段不是可加轉場的影片或圖片。"); return false; }
    const window = windowFor(cut, preset, project.fps, options.frames);
    if (typeof window === "string") { deps.setStatus(window); return false; }
    const transitionId = cut.transition?.id ?? deps.makeId("transition");
    if (preset.kind !== "matte") {
      const label = presetLabel(preset);
      if (!dispatch(basicTransitionCommandV1(cut, transitionId, window, preset.kind), `已在剪接點加入「${label}」${((window.before + window.after) / project.fps).toFixed(2)} 秒，可復原。`)) return false;
      deps.store.rememberTransition(preset);
      selectTransition(transitionId);
      return true;
    }
    const key = `${cut.trackId}\u0000${cut.fromClipId}\u0000${cut.toClipId}`;
    transitionJobs.get(key)?.abort();
    const controller = new AbortController();
    transitionJobs.set(key, controller);
    let facts: CatalogFacts;
    try { facts = await catalogFacts(preset.itemId); } catch (error) { deps.setStatus(error instanceof Error ? error.message : "找不到這個轉場。"); return false; }
    if (facts.kind !== "transition") { deps.setStatus(`「${facts.name}」不是轉場，請拖到軌道上。`); return false; }
    const rate = motionLibraryFrameRateV1(project.fps);
    const params = { ...(preset.params ?? {}), durationSeconds: motionLibraryClipSecondsV1(window.before + window.after, rate) };
    deps.pause?.();
    const rendered = await render(facts.name, preset.itemId, { kind: "cut", cut: ref }, params, controller);
    if (transitionJobs.get(key) === controller) transitionJobs.delete(key);
    if (!rendered || controller.signal.aborted || deps.sessionToken() !== token) return false;
    const current = deps.getProject(), now = findCutV1(current, ref);
    if (!now || now.locked) { deps.setStatus("剪接點在產生轉場時改變了，未套用；請再試一次。"); return false; }
    const fits = now.maxBefore >= window.before && now.maxAfter >= window.after;
    if (!fits) { deps.setStatus("剪接點在產生轉場時改變了，轉場已放不下；請再試一次。"); return false; }
    let command: EditorCommand;
    try { command = matteTransitionCommandV1(current, rendered, now, now.transition?.id ?? transitionId, window); }
    catch (error) { deps.setStatus(error instanceof Error ? error.message : "無法套用轉場。"); return false; }
    if (!dispatch(command, `已在剪接點加入「${facts.name}」轉場，可復原。`, rendered.previewUrls)) return false;
    deps.store.rememberTransition({ kind: "matte", itemId: preset.itemId, ...(preset.params ? { params: preset.params } : {}) });
    selectTransition(now.transition?.id ?? transitionId);
    return true;
  }

  function cutNearPlayhead(): MotionLibraryCutPointV1 | undefined {
    const project = deps.getProject();
    return nearestCutV1(project, deps.getPlayhead(), selectedTrackId(project));
  }

  /** The focused cut (opened from its transition button), else the cut nearest the playhead. */
  function applyTransitionNearPlayhead(preset: MotionLibraryTransitionPresetV1): Promise<boolean> {
    const focus = deps.store.getSnapshot().focusCut;
    const cut = focus && findCutV1(deps.getProject(), focus) ? focus : cutNearPlayhead();
    if (!cut) { deps.setStatus(MOTION_LIBRARY_NO_CUT_V1); return Promise.resolve(false); }
    return applyTransition(preset, cut);
  }

  function selectTransition(transitionId: string | undefined): void {
    deps.store.selectTransition(transitionId);
    if (!transitionId) return;
    deps.clearClipSelection();
    deps.revealSelection?.();
  }

  function removeTransition(transitionId: string): boolean {
    const transition = deps.getProject().timelineTransitions?.find(candidate => candidate.id === transitionId);
    if (!transition) { deps.store.selectTransition(undefined); return false; }
    const accepted = dispatch({ type: "delete_timeline_transition", transitionId }, "已移除轉場，可復原。");
    if (accepted) deps.store.selectTransition(undefined);
    return accepted;
  }

  /** A new window for an applied transition (its edges dragged). A matte transition re-renders at the new length first. */
  async function resizeTransition(transitionId: string, window: MotionLibraryTransitionWindowV1): Promise<boolean> {
    const project = deps.getProject();
    const transition = project.timelineTransitions?.find(candidate => candidate.id === transitionId);
    const cut = transition ? findTransitionCutV1(project, transitionId) : undefined;
    if (!transition || !cut) return false;
    if (window.before === transition.beforeFrames && window.after === transition.afterFrames) return true;
    if (transition.kernel !== "matte" || !transition.motionLibrary) {
      return dispatch({ type: "set_timeline_transition", transition: { ...transition, beforeFrames: window.before, afterFrames: window.after } },
        `轉場長度改為 ${((window.before + window.after) / project.fps).toFixed(2)} 秒，可復原。`);
    }
    const { durationSeconds: _old, ...params } = transition.motionLibrary.params as Record<string, unknown>;
    return applyMatteRevision(transitionId, cut, transition.motionLibrary.itemId, params, window);
  }

  async function applyMatteRevision(transitionId: string, cut: MotionLibraryCutPointV1, itemId: string, params: Record<string, unknown>,
    window: MotionLibraryTransitionWindowV1): Promise<boolean> {
    const project = deps.getProject(), token = deps.sessionToken();
    transitionJobs.get(transitionId)?.abort();
    const controller = new AbortController();
    transitionJobs.set(transitionId, controller);
    let facts: CatalogFacts;
    try { facts = await catalogFacts(itemId); } catch { return false; }
    const rate = motionLibraryFrameRateV1(project.fps);
    const rendered = await render(facts.name, itemId, { kind: "cut", cut }, { ...params, durationSeconds: motionLibraryClipSecondsV1(window.before + window.after, rate) }, controller);
    if (transitionJobs.get(transitionId) === controller) transitionJobs.delete(transitionId);
    if (!rendered || controller.signal.aborted || deps.sessionToken() !== token) return false;
    const current = deps.getProject(), now = findTransitionCutV1(current, transitionId);
    if (!now || now.maxBefore < window.before || now.maxAfter < window.after) { deps.setStatus("剪接點在產生轉場時改變了，未套用；請再試一次。"); return false; }
    try { return dispatch(matteTransitionCommandV1(current, rendered, now, transitionId, window), `已更新「${facts.name}」轉場，可復原。`, rendered.previewUrls); }
    catch (error) { deps.setStatus(error instanceof Error ? error.message : "無法更新轉場。"); return false; }
  }

  /** New params for a matte transition (the inspector); the window stays. */
  function updateTransitionParams(transitionId: string, params: Record<string, unknown>): Promise<boolean> {
    const project = deps.getProject();
    const transition = project.timelineTransitions?.find(candidate => candidate.id === transitionId);
    const cut = transition ? findTransitionCutV1(project, transitionId) : undefined;
    if (!transition?.motionLibrary || !cut) return Promise.resolve(false);
    const { durationSeconds: _keep, ...rest } = params;
    return applyMatteRevision(transitionId, cut, transition.motionLibrary.itemId, rest, { before: transition.beforeFrames, after: transition.afterFrames });
  }

  /** New params for a text or background clip (the inspector): re-render, then one update command. A newer edit cancels an older render. */
  async function updateClipParams(clipId: string, params: Record<string, unknown>): Promise<boolean> {
    const before = deps.getProject(), token = deps.sessionToken();
    const clip = before.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId);
    if (!clip?.motionLibrary) return false;
    clipJobs.get(clipId)?.abort();
    const controller = new AbortController();
    clipJobs.set(clipId, controller);
    let facts: CatalogFacts;
    try { facts = await catalogFacts(clip.motionLibrary.itemId); } catch { return false; }
    const rendered = await render(facts.name, clip.motionLibrary.itemId, { kind: "clip", clipId }, params, controller);
    if (clipJobs.get(clipId) === controller) clipJobs.delete(clipId);
    if (!rendered || controller.signal.aborted || deps.sessionToken() !== token) return false;
    const current = deps.getProject().tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId) as TimelineClip | undefined;
    if (!current?.motionLibrary) { deps.setStatus("這個動態素材已被刪除，未套用修改。"); return false; }
    if (current.motionLibrary.cacheKey === rendered.cacheKey) return true;
    try { return dispatch(motionLibraryUpdateCommandV1(deps.getProject(), current, rendered), `已更新「${facts.name}」，可復原。`, rendered.previewUrls); }
    catch (error) { deps.setStatus(error instanceof Error ? error.message : "無法更新動態素材。"); return false; }
  }

  const keyboard: MotionLibraryKeyboardActionsV1 = {
    applyLastTransition: () => { void applyTransitionNearPlayhead(deps.store.getSnapshot().lastTransition); },
    deleteSelectedTransition: () => {
      const id = deps.store.getSnapshot().selectedTransitionId;
      if (!id) return false;
      if (!deps.getProject().timelineTransitions?.some(transition => transition.id === id)) { deps.store.selectTransition(undefined); return false; }
      removeTransition(id);
      return true;
    },
  };

  return {
    addItem, applyTransition, applyTransitionNearPlayhead, removeTransition, resizeTransition, selectTransition,
    updateClipParams, updateTransitionParams, keyboard,
    /** A plain status line (an impossible drop, a refused edit). */
    notify: (message: string) => deps.setStatus(message),
    cancelAll() { for (const job of deps.store.getSnapshot().jobs) job.cancel(); },
    /** True while a render is running for this card, clip or cut. */
    busyFor(target: MotionLibraryJobTargetV1): boolean {
      return deps.store.getSnapshot().jobs.some(job => JSON.stringify(job.target) === JSON.stringify(target));
    },
  };
}

export type MotionLibraryControllerV1 = ReturnType<typeof createMotionLibraryControllerV1>;
