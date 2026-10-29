import type {EditorCommand} from "../domain/commandTypes";
import type {ColorGradeV2, EditProject} from "../domain/types";
import type {ProjectSessionSnapshot} from "./projectSession";
import type {GraphicEditingSelectionSnapshotV1} from "./graphicEditingSelectionV1";
import type {ClipParameterPlanV1} from "./clipParameterGestureV1";
import {findClip} from "../domain/editGraph";
import {editorCommandSchema} from "../domain/schema";
import {colorGradeV2Schema} from "../domain/colorGradeV2Schema";
import {findFilmLookV2} from "../creative/filmLooksV2";
import {CLIP_APPEARANCE_INVALID_V1, CLIP_APPEARANCE_STALE_V1} from "./clipAppearanceEditsV1";

interface Host {
  getSnapshot: () => ProjectSessionSnapshot;
  getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}
interface View {project: EditProject; clipId?: string; selection: GraphicEditingSelectionSnapshotV1}
const key = (value: unknown) => JSON.stringify(value ?? null);
// The schema's field order is canonical; equivalent authored object insertion order is not an edit.
const gradeKey = (value: ColorGradeV2 | null | undefined) => key(value == null ? null : colorGradeV2Schema.parse(value));
function replaces(command: EditorCommand, clipId: string): boolean {
  if (command.type === "batch") return command.commands.some(value => replaces(value, clipId));
  if (command.type === "add_clip") return command.clip.id === clipId;
  return "clipId" in command && command.clipId === clipId
    && ["delete_clip", "ripple_delete_clip", "replace_clip_source"].includes(command.type);
}

/** Atomic full-grade CAS, with the existing command/schema/history as the only writer. */
export function createClipGradeEditsV1(host: Host, view: View) {
  const captured = host.getSnapshot(), journal = captured.history.journal;
  let acknowledged: string | undefined;
  const refuse = (message = CLIP_APPEARANCE_STALE_V1) => {
    if (host.getSnapshot().sessionId === captured.sessionId) host.setStatus(message);
    return false;
  };
  function context() {
    const snapshot = host.getSnapshot(), project = snapshot.history.present, selection = host.getSelectionSnapshot();
    if (snapshot.sessionId !== captured.sessionId) return undefined;
    if (captured.history.present !== view.project || !view.clipId || selection !== view.selection || !selection.active || selection.selection
      || selection.timelineSelection.primaryClipId !== view.clipId || selection.timelineSelection.primaryCaptionId !== undefined
      || project.id !== view.project.id || key(project.colorManagement) !== key(view.project.colorManagement)) { refuse(); return undefined; }
    const clip = findClip(project, view.clipId), before = findClip(view.project, view.clipId);
    const track = project.tracks.find(value => value.id === clip.trackId), source = project.assets.find(value => value.id === clip.assetId);
    const oldSource = view.project.assets.find(value => value.id === before.assetId), liveJournal = snapshot.history.journal;
    if (!track || track.locked || track.kind !== "video" || !source || !oldSource || !["image", "video"].includes(source.kind)
      || (clip.layer?.role ?? "content") !== "content"
      || ["assetId", "trackId", "timelineStart", "sourceStart", "duration", "speed", "timeRemap"].some(field => key(clip[field as keyof typeof clip]) !== key(before[field as keyof typeof clip]))
      || ["kind", "uri", "width", "height", "duration", "displayAspectRatio", "compositionId", "imageSequence", "clipRetime"].some(field => key(source[field as keyof typeof source]) !== key(oldSource[field as keyof typeof source]))
      || liveJournal.length < journal.length || journal.length > 0 && liveJournal[journal.length - 1] !== journal.at(-1)
      || liveJournal.slice(journal.length).some(record => replaces(record.command, clip.id))
      || gradeKey(clip.gradeV2) !== (acknowledged ?? gradeKey(before.gradeV2))) { refuse(); return undefined; }
    return {snapshot, clip};
  }
  function set(grade: ColorGradeV2 | null, planned?: (plan: ClipParameterPlanV1) => void): boolean {
    try {
      const ctx = context(); if (!ctx) return false;
      const parsed = editorCommandSchema.safeParse({type: "set_clip_grade_v2", clipId: ctx.clip.id, grade});
      if (!parsed.success || parsed.data.type !== "set_clip_grade_v2"
        || parsed.data.grade?.look && !findFilmLookV2(parsed.data.grade.look.id)) return refuse(CLIP_APPEARANCE_INVALID_V1);
      const next = gradeKey(parsed.data.grade);
      if (next === gradeKey(ctx.clip.gradeV2)) { planned?.({}); return true; }
      const live = host.getSnapshot();
      if (live.sessionId !== ctx.snapshot.sessionId || live.history !== ctx.snapshot.history || host.getSelectionSnapshot() !== view.selection) return refuse();
      if (planned) { planned({command: parsed.data}); return true; }
      if (host.runCommand(parsed.data, grade ? "已更新 v2 調色。" : "已移除 v2 調色。") === false) return false;
      const after = host.getSnapshot();
      if (after.sessionId !== captured.sessionId) return false;
      if (after.history === ctx.snapshot.history || gradeKey(findClip(after.history.present, ctx.clip.id).gradeV2) !== next) return refuse(CLIP_APPEARANCE_INVALID_V1);
      acknowledged = next; return true;
    } catch (error) { return refuse(error instanceof Error ? error.message : CLIP_APPEARANCE_INVALID_V1); }
  }
  const lookGrade = (strength: number) => {
    const ctx = context(), grade = ctx?.clip.gradeV2;
    return grade?.look ? {...grade, look: {...grade.look, strength}} : undefined;
  };
  return {
    set: (grade: ColorGradeV2 | null) => set(grade),
    plan: (grade: ColorGradeV2): ClipParameterPlanV1 | undefined => {
      let result: ClipParameterPlanV1 | undefined; set(grade, plan => { result = plan; }); return result;
    },
    lookStrength: (strength: number): boolean => { const grade = lookGrade(strength); return grade ? set(grade) : false; },
    planLookStrength: (strength: number): ClipParameterPlanV1 | undefined => {
      const grade = lookGrade(strength); if (!grade) return undefined;
      let result: ClipParameterPlanV1 | undefined; set(grade, plan => { result = plan; }); return result;
    },
  };
}
