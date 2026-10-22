import type { CaptionPatch, EditorCommand } from "../domain/commandTypes";
import type { CaptionCue, CaptionStyle, EditProject } from "../domain/types";
import type { ProjectSessionSnapshot } from "./projectSession";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import type { ParameterGestureLeaseV1 } from "./transientParameterGestureV1";
import { alignTime, findCaption } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";

export type CaptionEditIntentV1 = "translation-text";
export type CaptionTextFieldV1 = "text" | "translation";
export interface CaptionEditPlanV1 { command?: EditorCommand }
interface Host {
  getSnapshot: () => ProjectSessionSnapshot; getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  runCommand: (command: EditorCommand, message?: string) => boolean | void; setStatus: (message: string) => void;
}
interface View { project: EditProject; captionId?: string; selection: GraphicEditingSelectionSnapshotV1 }
const STALE = "此圖層或選取內容已變更，請重新選取後再修改。";
const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
function replacesCaption(command: EditorCommand, id: string): boolean {
  return command.type === "batch" ? command.commands.some(c => replacesCaption(c, id))
    : command.type === "delete_caption" ? command.captionId === id : command.type === "add_caption" && command.caption.id === id;
}
export function normalizeCaptionStylePatchV1(value: Partial<CaptionStyle>): Partial<CaptionStyle> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(STALE);
  const parsed = editorCommandSchema.parse({ type: "set_caption_style", patch: value });
  if (parsed.type !== "set_caption_style" || Object.keys(value).some(key => !Object.hasOwn(parsed.patch, key))
    || Object.entries(value).some(([key, v]) => typeof v === "number" && !Number.isFinite(v)
      || v === undefined && !["shadowColor", "shadowBlur", "maxLineEm"].includes(key))) throw Error(STALE);
  return parsed.patch;
}
/** Exact persisted alpha, not the rounded display percentage (all 256 byte values must remain admissible). */
export const captionBackgroundOpacityV1 = (color: string) => (parseInt(color.slice(7, 9) || "00", 16) / 255) * 100;
export function captionBackgroundWithOpacityV1(color: string, value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw Error(STALE);
  const alpha = Math.round(value * 2.55).toString(16).padStart(2, "0").toUpperCase();
  // Preserve an unchanged authored representation; case or an omitted alpha is not an edit.
  return (color.slice(7, 9) || "00").toUpperCase() === alpha ? color : `${color.slice(0, 7)}${alpha}`;
}
/** Current selected caption -> changed fields -> original command/history. No second project or renderer owner. */
export function createCaptionEditingActionsV1(host: Host, view: View) {
  const captured = host.getSnapshot(), journal = captured.history.journal, ownWrites = new Map<string, unknown>();
  const reject = (message = STALE) => { if (host.getSnapshot().sessionId === captured.sessionId) host.setStatus(message); return false; };
  const context = () => {
    const snapshot = host.getSnapshot(), project = snapshot.history.present, selection = host.getSelectionSnapshot();
    if (captured.history.present !== view.project || snapshot.sessionId !== captured.sessionId || project.id !== view.project.id
      || project.fps !== view.project.fps || project.width !== view.project.width || project.height !== view.project.height
      || selection !== view.selection || !selection.active || selection.selection || !view.captionId
      || selection.timelineSelection.primaryCaptionId !== view.captionId || selection.timelineSelection.primaryClipId !== undefined) return undefined;
    const liveJournal = snapshot.history.journal;
    if (liveJournal.length < journal.length || journal.length > 0 && liveJournal[journal.length - 1] !== journal.at(-1)
      || liveJournal.slice(journal.length).some(record => replacesCaption(record.command, view.captionId!))) return undefined;
    try { return { snapshot, project, current: findCaption(project, view.captionId), before: findCaption(view.project, view.captionId) }; } catch { return undefined; }
  };
  function apply(input: CaptionPatch | Partial<CaptionStyle>, style: boolean, intent?: CaptionEditIntentV1, planned?: (plan: CaptionEditPlanV1) => void): boolean {
    try {
      const ctx = context(); if (!ctx) return planned ? false : reject();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error(STALE);
      const changes: Record<string, unknown> = {}, writes = new Map<string, unknown>();
      if (style) {
        if (intent !== undefined) throw Error(STALE);
        const next = normalizeCaptionStylePatchV1(input as Partial<CaptionStyle>);
        for (const key of Object.keys(next) as Array<keyof CaptionStyle>) {
          const token = "style." + key, expected = ownWrites.has(token) ? ownWrites.get(token) : view.project.captionStyle[key];
          if (same(next[key], expected)) continue;
          if (!same(ctx.project.captionStyle[key], expected)) throw Error(STALE);
          changes[key] = next[key]; writes.set(token, next[key]);
        }
      } else {
        const parsed = editorCommandSchema.parse({ type: "update_caption", captionId: view.captionId, patch: input });
        if (parsed.type !== "update_caption" || Object.keys(input).some(key => !Object.hasOwn(parsed.patch, key))
          || Object.values(input).some(v => v === undefined || typeof v === "number" && !Number.isFinite(v))) throw Error(STALE);
        if (intent !== undefined && (intent !== "translation-text" || Object.keys(input).length !== 1 || !parsed.patch.translation)) throw Error(STALE);
        for (const key of Object.keys(parsed.patch) as Array<keyof CaptionPatch>) {
          const value = parsed.patch[key];
          if (key === "translation" && value !== null && value !== undefined) {
            const next = value as NonNullable<CaptionCue["translation"]>, live = ctx.current.translation;
            if (intent === "translation-text" && (!ctx.before.translation || !live)) throw Error(STALE);
            const merged = { ...(live ?? next) }; let changed = false;
            for (const part of intent === "translation-text" ? ["text"] as const : ["text", "language"] as const) {
              const token = "cue.translation." + part, expected = ownWrites.has(token) ? ownWrites.get(token) : ctx.before.translation?.[part];
              if (same(next[part], expected)) continue;
              if (!same(live?.[part], expected)) throw Error(STALE);
              merged[part] = next[part]; changed = true; writes.set(token, next[part]);
            }
            if (changed) changes.translation = merged;
          } else {
            const token = "cue." + key, original = ctx.before[key as keyof CaptionCue];
            const expected = ownWrites.has(token) ? ownWrites.get(token) : original;
            const desired = key === "translation" && value === null ? undefined
              : (key === "start" || key === "duration") ? alignTime(value as number, view.project.fps) : value;
            if (same(desired, expected)) continue;
            if (!same(ctx.current[key as keyof CaptionCue], expected)) throw Error(STALE);
            changes[key] = key === "translation" ? null : desired; writes.set(token, desired);
          }
        }
      }
      if (!writes.size) { planned?.({}); return true; }
      const ready = host.getSnapshot();
      if (ready.sessionId !== ctx.snapshot.sessionId || ready.history !== ctx.snapshot.history || host.getSelectionSnapshot() !== view.selection) return planned ? false : reject();
      const command: EditorCommand = style ? { type: "set_caption_style", patch: changes as Partial<CaptionStyle> }
        : { type: "update_caption", captionId: view.captionId!, patch: changes as CaptionPatch };
      if (planned) { planned({ command }); return true; }
      if (host.runCommand(command, style ? "已更新字幕字型，預覽與輸出會使用內建字型。" : "已更新字幕。") === false) return false;
      const after = host.getSnapshot(); if (after.sessionId !== captured.sessionId || after.history === ctx.snapshot.history) return reject();
      const cue = findCaption(after.history.present, view.captionId!);
      for (const [token, desired] of writes) {
        const [, field, part] = token.split(".");
        const actual = token.startsWith("style.") ? after.history.present.captionStyle[field as keyof CaptionStyle]
          : field === "translation" && part ? cue.translation?.[part as "text" | "language"] : cue[field as keyof CaptionCue];
        if (!same(actual, desired)) return reject();
      }
      for (const [token, value] of writes) ownWrites.set(token, structuredClone(value));
      if (Object.hasOwn(changes, "translation")) ownWrites.set("cue.translation", structuredClone(cue.translation));
      return true;
    } catch (error) { return planned ? false : reject(error instanceof Error ? error.message : STALE); }
  }
  const plan = (run: (capture: (value: CaptionEditPlanV1) => void) => boolean) => { let value: CaptionEditPlanV1 | undefined; return run(next => { value = next; }) ? value : undefined; };
  const textPatch = (field: CaptionTextFieldV1, value: string): CaptionPatch | undefined => field === "text" ? { text: value }
    : view.captionId && view.project.captions.find(c => c.id === view.captionId)?.translation
      ? { translation: { ...findCaption(view.project, view.captionId).translation!, text: value } } : undefined;
  return {
    isCurrent: () => Boolean(context()),
    patch: (value: CaptionPatch, intent?: CaptionEditIntentV1) => apply(value, false, intent),
    style: (value: Partial<CaptionStyle>) => apply(value, true),
    planPatch: (value: CaptionPatch, intent?: CaptionEditIntentV1) => plan(capture => apply(value, false, intent, capture)),
    planStyle: (value: Partial<CaptionStyle>) => plan(capture => apply(value, true, undefined, capture)),
    text: (field: CaptionTextFieldV1, value: string) => { const patch = textPatch(field, value); return patch ? apply(patch, false, field === "translation" ? "translation-text" : undefined) : reject(); },
    planText: (field: CaptionTextFieldV1, value: string) => { const patch = textPatch(field, value); return patch ? plan(capture => apply(patch, false, field === "translation" ? "translation-text" : undefined, capture)) : undefined; },
    loadPreset: async (id: string, begin: () => (ParameterGestureLeaseV1<Partial<CaptionStyle>> & { isCurrent: () => boolean }) | undefined,
      load: (id: string) => Promise<Partial<CaptionStyle>>): Promise<boolean> => {
      const lease = begin(); if (!lease) return false;
      try { const value = await load(id); if (!lease.update(value)) { lease.cancel(); return false; } return lease.commit(); }
      catch (error) { const current = lease.isCurrent(); lease.cancel(); if (current && context()) host.setStatus(error instanceof Error ? error.message : "無法載入文字風格"); return false; }
    },
  };
}
