import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { ProjectSessionSnapshot } from "./projectSession";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { commandReplacesGraphicV1 } from "./graphicEditingSelectionV1";
import { editorCommandSchema } from "../domain/schema";
import { clipAttachments } from "./timelineMotionEdits";

export const GRAPHIC_EDIT_STALE_V1 = "此圖層或選取內容已變更，請重新選取後再修改。";
export const GRAPHIC_EDIT_INVALID_V1 = "無法更新動態圖層。";
const OWNED = "此圖層由場景或模板管理，請使用對應的場景／模板編輯器。";
type Patch = Partial<Omit<MotionGraphic, "schema" | "id">>;
export interface MotionGraphicEditPlanV1 { command?: EditorCommand }
interface Host {
  getSnapshot: () => ProjectSessionSnapshot;
  getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => same(value, right[i]));
  if (!record(left) || !record(right)) return false;
  const a = Object.keys(left).filter(key => left[key] !== undefined), b = Object.keys(right).filter(key => right[key] !== undefined);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}
function merge(current: unknown, expected: unknown, next: unknown, path: string): unknown {
  if (same(expected, next)) return structuredClone(current);
  if (record(expected) && record(next) && record(current)) {
    for (const key of ["schema", "kind", "type"]) if (!same(expected[key], current[key])) throw Error(GRAPHIC_EDIT_STALE_V1);
    const result = { ...current };
    for (const key of new Set([...Object.keys(expected), ...Object.keys(next)])) {
      if (same(expected[key], next[key])) continue;
      const value = merge(current[key], expected[key], next[key], `${path}.${key}`);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  if (path === "vectorV2.groupColors" && Array.isArray(current) && Array.isArray(expected) && Array.isArray(next)
    && current.length === 3 && expected.length === 3 && next.length === 3) {
    return next.map((value, index) => merge(current[index], expected[index], value, `${path}.${index}`));
  }
  // Geometry and keyframe lists are authored units, not speculative per-index merges.
  if (!same(current, expected)) throw Error(GRAPHIC_EDIT_STALE_V1);
  return structuredClone(next);
}

/** Rendered view -> changed-field CAS -> original canonical command/history, not another executor. */
export function createMotionGraphicEditActionsV1(host: Host, view: {
  project: EditProject; selection: GraphicEditingSelectionSnapshotV1; clipId?: string; libraryDeleteOnly?: boolean;
}) {
  const rendered = host.getSnapshot(), journal = rendered.history.journal, ownWrites = new Map<string, unknown>();
  function context(id: string, quiet = false) {
    const snapshot = host.getSnapshot(), project = snapshot.history.present, selection = host.getSelectionSnapshot();
    if (snapshot.sessionId !== rendered.sessionId) return undefined;
    const stale = () => { if (!quiet) host.setStatus(GRAPHIC_EDIT_STALE_V1); return undefined; };
    // The shell also renders for playback. Do not scan/copy every graphic until an actual edit is invoked.
    const current = project.motionGraphics.find(graphic => graphic.id === id), before = view.project.motionGraphics.find(graphic => graphic.id === id);
    const allowed = view.libraryDeleteOnly || (view.clipId ? clipAttachments(view.project, view.clipId).graphics.some(graphic => graphic.id === id) : view.selection.selection?.id === id);
    if (rendered.history.present !== view.project || selection !== view.selection || !selection.active || !allowed || !current || !before
      || project.id !== view.project.id || current.schema !== before.schema || current.kind !== before.kind || current.presetId !== before.presetId
      || current.trackId !== before.trackId || !same(current.templateOwner, before.templateOwner)) return stale();
    if (!view.libraryDeleteOnly && (view.clipId ? selection.selection !== undefined || selection.timelineSelection.primaryClipId !== view.clipId
      || selection.timelineSelection.primaryCaptionId !== undefined || !clipAttachments(project, view.clipId).graphics.some(graphic => graphic.id === id)
      : selection.selection?.id !== id || selection.timelineSelection.primaryClipId !== undefined || selection.timelineSelection.primaryCaptionId !== undefined)) return stale();
    const liveJournal = snapshot.history.journal;
    if (liveJournal.length < journal.length || journal.length > 0 && liveJournal[journal.length - 1] !== journal.at(-1)) return stale();
    if (liveJournal.slice(journal.length).some(record => commandReplacesGraphicV1(record.command, id))) return stale();
    if (project.motionScenes?.some(scene => scene.graphicIds.includes(id))
      || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === id))) {
      if (!quiet) host.setStatus(OWNED); return undefined;
    }
    return { snapshot, current, before };
  }
  const unchanged = (snapshot: ProjectSessionSnapshot) => {
    const live = host.getSnapshot();
    return live.sessionId === snapshot.sessionId && live.history === snapshot.history && host.getSelectionSnapshot() === view.selection;
  };
  const failed = (error: unknown) => { host.setStatus(error instanceof Error ? error.message : GRAPHIC_EDIT_INVALID_V1); return false; };
  function update(id: string, patch: Patch, planned?: (plan: MotionGraphicEditPlanV1) => void): boolean {
      try {
        if (view.libraryDeleteOnly) throw Error(GRAPHIC_EDIT_INVALID_V1);
        const live = context(id, Boolean(planned)); if (!live) return false;
        if (Object.hasOwn(patch, "id") || Object.hasOwn(patch, "schema")) throw Error(GRAPHIC_EDIT_INVALID_V1);
        const parsed = editorCommandSchema.safeParse({ type: "update_motion_graphic", graphicId: id, patch });
        if (!parsed.success || parsed.data.type !== "update_motion_graphic") throw Error(GRAPHIC_EDIT_INVALID_V1);
        const parsedPatch = parsed.data.patch;
        if (Object.keys(patch).some(key => !Object.hasOwn(parsedPatch, key))) throw Error(GRAPHIC_EDIT_INVALID_V1);
        const merged: Record<string, unknown> = {};
        for (const key of Object.keys(parsedPatch) as Array<keyof Patch>) {
          const value = parsedPatch[key];
          const token = `${id}.${key}`, expected = ownWrites.has(token) ? ownWrites.get(token) : live.before[key];
          const next = ["layoutV2", "motionV2", "vectorV2"].includes(key)
            ? merge(live.current[key], expected, value, key)
            : same(expected, value) ? live.current[key]
              : same(live.current[key], expected) ? structuredClone(value) : (() => { throw Error(GRAPHIC_EDIT_STALE_V1); })();
          if (!same(live.current[key], next)) merged[key] = next;
        }
        if (!unchanged(live.snapshot)) throw Error(GRAPHIC_EDIT_STALE_V1);
        if (!Object.keys(merged).length) { planned?.({}); return true; }
        const command: EditorCommand = { type: "update_motion_graphic", graphicId: id, patch: merged as Patch };
        if (planned) { planned({ command }); return true; }
        if (host.runCommand(command, "已更新動態圖卡，預覽與輸出會同步。") === false) return false;
        const after = host.getSnapshot(), acknowledged = after.history.present.motionGraphics.find(graphic => graphic.id === id);
        if (after.sessionId !== rendered.sessionId || after.history === live.snapshot.history || !acknowledged
          || Object.keys(merged).some(key => !same(acknowledged[key as keyof MotionGraphic], merged[key]))) throw Error(GRAPHIC_EDIT_STALE_V1);
        // Remember authored intent, not merged foreign fields; a later old-view patch must preserve those fields.
        for (const key of Object.keys(merged) as Array<keyof Patch>) ownWrites.set(`${id}.${key}`, structuredClone(parsedPatch[key]));
        return true;
      } catch (error) { return planned ? false : failed(error); }
  }
  return {
    update: (id: string, patch: Patch) => update(id, patch),
    planUpdate(id: string, patch: Patch): MotionGraphicEditPlanV1 | undefined {
      let plan: MotionGraphicEditPlanV1 | undefined;
      return update(id, patch, value => { plan = value; }) ? plan : undefined;
    },
    remove(id: string): boolean {
      try {
        const live = context(id); if (!live) return false;
        if (!same(live.current, live.before) || !unchanged(live.snapshot)) throw Error(GRAPHIC_EDIT_STALE_V1);
        return host.runCommand({ type: "delete_motion_graphic", graphicId: id }, "已刪除動態圖卡，可隨時復原。") !== false;
      } catch (error) { return failed(error); }
    },
  };
}
