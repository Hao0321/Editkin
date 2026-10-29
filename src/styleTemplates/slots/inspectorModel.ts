import type { EditorCommand } from "../../domain/commandTypes";
import { motionLibraryClipSecondsV1, motionLibraryFrameRateV1 } from "../../domain/motionLibraryV1";
import type { StyleImageSlotValueV1, StyleSlotValuesV1 } from "../../domain/styleJobFieldsV1";
import type { EditProject, MediaAsset, TimelineClip } from "../../domain/types";
import { styleTemplateUpdateClipCommandV1 } from "./clipCommands";
import { findStyleSlotTemplateV1, type StyleSlotTemplateV1 } from "./slotCatalog";
import { styleSlotTextLength, validateStyleSlotValuesV1, type StyleTextSlot } from "./slotSchema";
import { STYLE_TEMPLATE_CANCELLED_V1, STYLE_TEMPLATE_NATIVE_REQUIRED_V1, type StyleTemplateRenderHostV1 } from "./renderHost";

/**
 * The 「模板」 inspector's logic (browser-safe, no React): a draft of the clip's slots, its validation, and the re-render
 * that turns a valid draft into one update_style_template_clip (one Undo). Like the Motion Library inspector, an edit
 * re-renders after a short pause; a newer edit cancels the older render; a render that finishes after the clip changed
 * under it (Undo, another edit) is dropped instead of overwriting it.
 */

export type StyleTemplateInspectorStatusV1 = "idle" | "invalid" | "waiting" | "rendering" | "applied" | "no_host" | "failed";

export interface StyleTemplateInspectorStateV1 {
  readonly draft: StyleSlotValuesV1;
  /** Picture files chosen in this inspector that the project does not hold yet (imported with the next update). */
  readonly pendingAssets: readonly MediaAsset[];
  readonly status: StyleTemplateInspectorStatusV1;
  readonly progress?: { readonly phase: string; readonly fraction: number };
  readonly message?: string;
}

export function styleTemplateDraftFromClipV1(clip: TimelineClip): StyleSlotValuesV1 {
  return structuredClone(clip.styleJob?.slots ?? { text: {}, color: {}, image: {} });
}

export function styleTemplateTextCounterV1(slot: Pick<StyleTextSlot, "maxLength">, value: string): { length: number; max: number; over: boolean } {
  const length = styleSlotTextLength(value.normalize("NFC").trim());
  return { length, max: slot.maxLength, over: length > slot.maxLength };
}

/** The draft against the template's declarations: canonical slots, or the first problem with its stable code. */
export function styleTemplateDraftCheckV1(template: StyleSlotTemplateV1, draft: StyleSlotValuesV1): { ok: true; slots: StyleSlotValuesV1 } | { ok: false; code: string; message: string } {
  try { return { ok: true, slots: validateStyleSlotValuesV1(template, draft) }; }
  catch (error) { return { ok: false, code: (error as { code?: string }).code ?? "STYLE_SLOT_VALUES_INVALID", message: error instanceof Error ? error.message : String(error) }; }
}

/** Removes a colour override (one role, or all): the role follows the template again. */
export function styleTemplateResetColorV1(draft: StyleSlotValuesV1, role?: string): StyleSlotValuesV1 {
  if (role === undefined) return { ...draft, color: {} };
  const color = { ...draft.color } as Record<string, string>;
  delete color[role];
  return { ...draft, color };
}

/**
 * 「播放頭畫面」: the frame of the footage under the playhead — the topmost visible video clip on a video track at that time
 * that is not a template clip itself — as a still source (asset and source time).
 */
export function styleTemplateStillAtPlayheadV1(project: EditProject, playhead: number): StyleImageSlotValueV1["source"] | undefined {
  for (const track of [...project.tracks].reverse()) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.styleJob || clip.motionLibrary || playhead < clip.timelineStart - 1e-9 || playhead >= clip.timelineStart + clip.duration) continue;
      const asset = project.assets.find(candidate => candidate.id === clip.assetId);
      if (!asset || asset.kind !== "video" || asset.compositionId !== undefined || asset.imageSequence !== undefined) continue;
      const time = clip.sourceStart + (playhead - clip.timelineStart) * (clip.speed ?? 1);
      return { kind: "still", assetId: asset.id, time: Math.max(0, Math.min(Math.round(time * 1000) / 1000, Math.max(0, asset.duration - 1 / project.fps))) };
    }
  }
  return undefined;
}

export interface StyleTemplateInspectorControllerDepsV1 {
  readonly getProject: () => EditProject;
  readonly clipId: string;
  readonly host: StyleTemplateRenderHostV1 | undefined;
  readonly runCommand: (command: EditorCommand) => boolean | void;
  readonly mergeRuntimeUrls?: (urls: Record<string, string>) => void;
  /** Pause after the last edit before re-rendering (ms). */
  readonly delayMs?: number;
}

export interface StyleTemplateInspectorControllerV1 {
  readonly getSnapshot: () => StyleTemplateInspectorStateV1;
  readonly subscribe: (listener: () => void) => () => void;
  /** A changed draft (and any newly imported picture files); re-renders after the pause when valid. */
  edit(draft: StyleSlotValuesV1, newAssets?: readonly MediaAsset[]): void;
  /** Re-render now (no pause). */
  flush(): Promise<void>;
  cancel(): void;
  /** The clip changed under the inspector (Undo, Redo, another clip): take its slots unless an edit is waiting. */
  sync(): void;
  dispose(): void;
}

export function createStyleTemplateInspectorControllerV1(deps: StyleTemplateInspectorControllerDepsV1): StyleTemplateInspectorControllerV1 {
  const clip = () => deps.getProject().tracks.flatMap(track => track.clips).find(candidate => candidate.id === deps.clipId);
  const template = () => { const field = clip()?.styleJob; return field ? findStyleSlotTemplateV1(field.template.id) : undefined; };
  let state: StyleTemplateInspectorStateV1 = { draft: styleTemplateDraftFromClipV1(clip() ?? ({} as TimelineClip)), pendingAssets: [], status: deps.host ? "idle" : "no_host",
    ...(deps.host ? {} : { message: STYLE_TEMPLATE_NATIVE_REQUIRED_V1 }) };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<StyleTemplateInspectorStateV1>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  let timer: ReturnType<typeof setTimeout> | undefined, running: AbortController | undefined, generation = 0;

  const render = async () => {
    timer = undefined;
    const current = clip(), declared = template();
    if (!current?.styleJob || !declared) return;
    const check = styleTemplateDraftCheckV1(declared, state.draft);
    if (!check.ok) { publish({ status: "invalid", message: check.message, progress: undefined }); return; }
    if (!deps.host) { publish({ status: "no_host", message: STYLE_TEMPLATE_NATIVE_REQUIRED_V1, progress: undefined }); return; }
    running?.abort();
    const controller = new AbortController(), mine = ++generation;
    running = controller;
    const project = deps.getProject(), rate = motionLibraryFrameRateV1(project.fps);
    const startedFrom = { assetId: current.assetId, key: current.styleJob.key };
    const assets = [...project.assets, ...state.pendingAssets].filter(asset => Object.values(check.slots.image).some(value => value.source.assetId === asset.id));
    publish({ status: "rendering", progress: { phase: "start", fraction: 0 }, message: undefined });
    try {
      const rendered = await deps.host.render({ templateId: current.styleJob.template.id, slots: check.slots, width: project.width, height: project.height, fps: project.fps,
        durationSeconds: motionLibraryClipSecondsV1(current.styleJob.job.frameCount, rate), assets },
      { signal: controller.signal, onProgress: progress => { if (mine === generation) publish({ progress: { phase: progress.phase, fraction: Math.max(0, Math.min(1, progress.fraction)) } }); } });
      if (mine !== generation) return;
      const latest = clip();
      // Dropped, not applied, when the clip changed while rendering (Undo, another edit, another window).
      if (!latest?.styleJob || latest.assetId !== startedFrom.assetId || latest.styleJob.key !== startedFrom.key) { publish({ status: "idle", progress: undefined }); return; }
      if (rendered.field.key === latest.styleJob.key) { publish({ status: "applied", progress: undefined }); return; }
      const command = styleTemplateUpdateClipCommandV1(deps.getProject(), latest, rendered, { slotAssets: state.pendingAssets });
      const accepted = deps.runCommand(command) !== false;
      if (accepted && Object.keys(rendered.previewUrls).length) deps.mergeRuntimeUrls?.({ ...rendered.previewUrls });
      publish(accepted ? { status: "applied", progress: undefined, pendingAssets: [] } : { status: "failed", progress: undefined, message: "STYLE_TEMPLATE_UPDATE_REFUSED" });
    } catch (error) {
      if (mine !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      publish(message === STYLE_TEMPLATE_CANCELLED_V1 || controller.signal.aborted ? { status: "idle", progress: undefined } : { status: "failed", progress: undefined, message });
    } finally {
      if (running === controller) running = undefined;
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    edit(draft, newAssets = []) {
      const pendingAssets = [...state.pendingAssets, ...newAssets.filter(asset => !state.pendingAssets.some(existing => existing.id === asset.id))];
      const declared = template();
      const check = declared ? styleTemplateDraftCheckV1(declared, draft) : undefined;
      if (timer) clearTimeout(timer);
      running?.abort(); generation += 1;
      if (check && !check.ok) { publish({ draft, pendingAssets, status: "invalid", message: check.message, progress: undefined }); return; }
      if (!deps.host) { publish({ draft, pendingAssets, status: "no_host", message: STYLE_TEMPLATE_NATIVE_REQUIRED_V1, progress: undefined }); return; }
      publish({ draft, pendingAssets, status: "waiting", message: undefined, progress: undefined });
      timer = setTimeout(() => { void render(); }, deps.delayMs ?? 500);
    },
    async flush() { if (timer) clearTimeout(timer); await render(); },
    cancel() { if (timer) clearTimeout(timer); timer = undefined; running?.abort(); generation += 1; publish({ status: "idle", progress: undefined }); },
    sync() {
      if (timer || running) return;
      const current = clip();
      if (current?.styleJob) publish({ draft: styleTemplateDraftFromClipV1(current), pendingAssets: [], ...(state.status === "invalid" ? { status: "idle", message: undefined } : {}) });
    },
    dispose() { if (timer) clearTimeout(timer); running?.abort(); generation += 1; listeners.clear(); },
  };
}
