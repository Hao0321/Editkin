import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { clipSlipError, formatEditSeconds, planClipExtension, type ClipEdge, type ClipExtensionPlan } from "../domain/clipSourceEdits";
import { runTemplateFollowGesture } from "./templateFollowEditActions";
import { editTouchesTemplates, planClipExtensionWithTemplates, planClipSlipWithTemplates, templateFollowGlyphs } from "./timelineMotionEdits";

export interface ClipSourceEditHost {
  /** The live project at the moment of the gesture's release, not a render-time copy. */
  getProject: () => EditProject;
  /** The editor's own command runner; only an explicit false means the command was refused. */
  runCommand: (command: EditorCommand, successMessage?: string) => boolean | void;
  setStatus: (message: string) => void;
  /** The glyph source a title template is laid out again with; the real fonts by default. */
  templateGlyphs?: () => ReturnType<typeof templateFollowGlyphs>;
}

export const EXTEND_KEEPS_CHANGING = "專案剛剛有變更，這次延長沒有套用；請再試一次。";
export const SLIP_KEEPS_CHANGING = "專案剛剛有變更，這次換入點沒有套用；請再試一次。";

/** What the status line says after an extension; every case names the single Undo. */
export function clipExtensionStatus(plan: ClipExtensionPlan): string {
  const seconds = formatEditSeconds(plan.seconds), push = formatEditSeconds(plan.pushSeconds);
  if (plan.edge === "end") {
    return plan.pushSeconds > 0
      ? `已把片段結尾延長 ${seconds} 秒，後面的內容一起往後移 ${push} 秒；一次復原即可還原。`
      : `已把片段結尾延長 ${seconds} 秒；一次復原即可還原。`;
  }
  if (plan.grewLater) {
    return plan.pushSeconds > 0
      ? `已把片段開頭延長 ${seconds} 秒；前面沒有空位，片段改往後長，後面的內容一起往後移 ${push} 秒。一次復原即可還原。`
      : `已把片段開頭延長 ${seconds} 秒；前面沒有空位，片段改往後長。一次復原即可還原。`;
  }
  return `已把片段開頭延長 ${seconds} 秒；一次復原即可還原。`;
}

export function clipSlipStatus(sourceStart: number): string {
  return `已換入點：素材改從 ${formatEditSeconds(sourceStart)} 秒開始；片段位置和長度不變，一次復原即可還原。`;
}

/**
 * Editor actions for longer clips and new in-points. Each accepted gesture is one command, so one Undo. A clip edit that
 * no title template is involved in runs at once (true/false). One that changes a saved title template — a new in-point
 * or a longer main clip, or an extension that pushes a template further on — lays the template out again (or records
 * it at its new place) in the same command; that takes a moment, so the result is a promise.
 */
export function createClipSourceEditActions(host: ClipSourceEditHost) {
  return {
    extendClip(clipId: string, edge: ClipEdge, seconds: number): boolean | Promise<boolean> {
      const project = host.getProject();
      const frames = Math.round(seconds * project.fps);
      let plan: ClipExtensionPlan;
      try { plan = planClipExtension(project, clipId, edge, frames); }
      catch (error) { host.setStatus(error instanceof Error ? error.message : "無法延長片段。"); return false; }
      const command: EditorCommand = { type: "extend_clip", clipId, edge, seconds: frames / project.fps };
      const plain = () => host.runCommand(command, clipExtensionStatus(plan)) !== false;
      if (!editTouchesTemplates(project, [command])) return plain();
      return runTemplateFollowGesture(host, (live, glyphs) => planClipExtensionWithTemplates(live, clipId, edge, frames / live.fps, glyphs),
        { failed: "無法延長片段。", changed: EXTEND_KEEPS_CHANGING }, plain);
    },
    slipClip(clipId: string, sourceStart: number): boolean | Promise<boolean> {
      const project = host.getProject();
      const error = clipSlipError(project, clipId, sourceStart);
      if (error) { host.setStatus(error); return false; }
      const command: EditorCommand = { type: "slip_clip", clipId, sourceStart };
      const plain = () => host.runCommand(command, clipSlipStatus(sourceStart)) !== false;
      if (!editTouchesTemplates(project, [command])) return plain();
      return runTemplateFollowGesture(host, (live, glyphs) => planClipSlipWithTemplates(live, clipId, sourceStart, glyphs),
        { failed: "無法換入點。", changed: SLIP_KEEPS_CHANGING }, plain);
    },
  };
}

export type ClipSourceEditActions = ReturnType<typeof createClipSourceEditActions>;
