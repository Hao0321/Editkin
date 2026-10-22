import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { trackTemplateFollow, yieldToBrowser } from "./templateFollowProgress";
import type { ReferenceMotionTemplateRebuildDependencies } from "./referenceMotionTemplateInstances";
import { editTouchesTemplates, planClipSplitWithTemplates, planEditCommandsWithTemplates, planRippleDeleteWithTemplates, templateEditMessage,
  templateFollowGlyphs, type MotionEditPlan, type TemplateNeedsReapply } from "./timelineMotionEdits";
import { planDeleteToPlayhead, planRippleDelete, rippleMessage, type DeleteToPlayheadPlan, type RippleEditPlan } from "./timelineRippleEdits";
import type { TimelineCut } from "./timelineSplitTarget";

export const SPLIT_KEEPS_CHANGING = "專案剛剛有變更，這次切開沒有套用；請再試一次。";
export const DELETE_KEEPS_CHANGING = "專案剛剛有變更，這次刪除沒有套用；請再試一次。";
const SPLIT_FAILED = "無法切開片段。";
const DELETE_FAILED = "無法刪除片段。";
/** The editor's own messages for a split and a ripple delete that no title template is involved in. */
export const splitDone = (at: number) => `已在 ${at.toFixed(2)} 秒分割。`;
/** Shift+click with the 剪刀 tool: several clips cut at one time (without the closing words, which depend on templates). */
export const splitManyDone = (at: number, count: number) => `已在 ${at.toFixed(2)} 秒切開 ${count} 段片段`;
export const RIPPLE_DELETE_DONE = "已刪除片段並自動補上空隙；復原一次即可完整還原。";

export interface TemplateFollowEditHost {
  /** The live project, read when a gesture starts and again when its plan is ready. */
  getProject: () => EditProject;
  /** The editor's own command runner; only an explicit false means the command was refused. */
  runCommand: (command: EditorCommand, successMessage?: string) => boolean | void;
  setStatus: (message: string) => void;
  /** The glyph source a title template is laid out again with; the real fonts by default. */
  templateGlyphs?: () => ReturnType<typeof templateFollowGlyphs>;
}

/**
 * Plan a clip gesture together with the title templates it changes, on the project as it is when the gesture is made,
 * then commit it as one command (one Undo). Planning takes a moment, so the status line says 「標題跟著調整中…」 when it
 * runs long (templateFollowProgress). When the project changed meanwhile (an Undo, another edit), the hint goes away at
 * once, the work is cancelled, nothing is applied, and the status says so: the gesture was made on a timeline that is no
 * longer there. `plain` runs instead when it turns out that no template is involved.
 */
export function runTemplateFollowGesture(host: TemplateFollowEditHost,
  plan: (project: EditProject, templates: ReferenceMotionTemplateRebuildDependencies) => Promise<MotionEditPlan | undefined>,
  words: { failed: string; changed: string }, plain: () => boolean): Promise<boolean> {
  const project = host.getProject(), glyphs = (host.templateGlyphs ?? templateFollowGlyphs)(), cancel = new AbortController();
  const stillCurrent = () => host.getProject() === project;
  return trackTemplateFollow((async () => {
    let made: MotionEditPlan | undefined, failure: { error: unknown } | undefined;
    // Let the editor finish the click and start the hint's clock before the long work begins.
    try { await yieldToBrowser(); made = await plan(project, { prepareText: glyphs.prepareText, signal: cancel.signal }); }
    catch (error) { failure = { error }; }
    finally { glyphs.dispose(); }
    if (!stillCurrent()) { host.setStatus(words.changed); return false; }
    if (failure) { host.setStatus(failure.error instanceof Error ? failure.error.message : words.failed); return false; }
    if (!made) return plain();
    return host.runCommand(made.command, made.message) !== false;
  })(), { stillCurrent, onStale: () => cancel.abort() });
}

/**
 * The editor's split and delete (the 切開 and 刪除 buttons, B and Delete). A clip no title template is involved in runs
 * the editor's own command at once, with its own message, exactly as before; true/false says whether it ran. When the
 * gesture changes a saved title template — splitting its main clip, or a ripple that carries templates further on —
 * the templates follow it in the same command, and the result is a promise.
 */
export function createTemplateFollowEditActions(host: TemplateFollowEditHost) {
  const split = (clipId: string, at: number, newClipId: string): boolean | Promise<boolean> => {
    const command: EditorCommand = { type: "split_clip", clipId, at, newClipId };
    const plain = () => host.runCommand(command, splitDone(at)) !== false;
    if (!editTouchesTemplates(host.getProject(), [command])) return plain();
    return runTemplateFollowGesture(host, (project, glyphs) => planClipSplitWithTemplates(project, clipId, at, newClipId, glyphs),
      { failed: SPLIT_FAILED, changed: SPLIT_KEEPS_CHANGING }, plain);
  };
  return {
    split,
    /**
     * The 剪刀 tool: one clip is the editor's split (the same command and words as 切開 and Ctrl+B); several (Shift+click
     * on every track) are one batch of the same split commands, one Undo, with the templates they change following.
     */
    splitMany(cuts: readonly TimelineCut[], makeClipId: () => string): boolean | Promise<boolean> {
      if (cuts.length === 1) return split(cuts[0].clipId, cuts[0].at, makeClipId());
      const commands: EditorCommand[] = cuts.map(cut => ({ type: "split_clip", clipId: cut.clipId, at: cut.at, newClipId: makeClipId() }));
      const done = splitManyDone(cuts[0]?.at ?? 0, cuts.length);
      const plain = () => host.runCommand({ type: "batch", commands }, `${done}。`) !== false;
      if (!editTouchesTemplates(host.getProject(), commands)) return plain();
      return runTemplateFollowGesture(host, async (project, glyphs) => {
        const followed = await planEditCommandsWithTemplates(project, commands, glyphs);
        return followed && { command: followed.command, message: templateEditMessage(done, followed) };
      }, { failed: SPLIT_FAILED, changed: SPLIT_KEEPS_CHANGING }, plain);
    },
    /**
     * Q and W (planDeleteToPlayhead): the part of the clip before or after the playhead goes and the gap closes, one
     * Undo. Undefined when there is nothing to delete (the status says why); otherwise the plan and whether it ran.
     */
    deleteToPlayhead(side: "left" | "right", playhead: number, selectedClipId: string | undefined, newClipId: string):
      { plan: DeleteToPlayheadPlan; ran: boolean | Promise<boolean> } | undefined {
      let plan: DeleteToPlayheadPlan;
      try { plan = planDeleteToPlayhead(host.getProject(), playhead, selectedClipId, side, newClipId); }
      catch (error) { host.setStatus(error instanceof Error ? error.message : DELETE_FAILED); return undefined; }
      const plain = () => host.runCommand(plan.command, plan.message) !== false;
      if (!editTouchesTemplates(host.getProject(), plan.edit)) return { plan, ran: plain() };
      return { plan, ran: runTemplateFollowGesture(host, async (project, glyphs) => {
        const followed = await planEditCommandsWithTemplates(project, plan.edit, glyphs);
        return followed && { command: followed.command, message: followedDeleteMessage(plan, followed.needsReapply) };
      }, { failed: DELETE_FAILED, changed: DELETE_KEEPS_CHANGING }, plain) };
    },
    rippleDelete(clipId: string): boolean | Promise<boolean> {
      // The CapCut-like ripple (planRippleDelete): never refused for overlap; the status says what stayed in place.
      let plan: RippleEditPlan;
      try { plan = planRippleDelete(host.getProject(), [clipId]); }
      catch (error) { host.setStatus(error instanceof Error ? error.message : DELETE_FAILED); return false; }
      const plain = () => host.runCommand(plan.command, plan.message) !== false;
      if (!editTouchesTemplates(host.getProject(), plan.command.type === "batch" ? plan.command.commands : [plan.command])) return plain();
      return runTemplateFollowGesture(host, (project, glyphs) => planRippleDeleteWithTemplates(project, clipId, glyphs),
        { failed: DELETE_FAILED, changed: DELETE_KEEPS_CHANGING }, plain);
    },
  };
}

/** Q and W when saved title templates further on moved with the ripple: the same words as a Delete that carried them. */
function followedDeleteMessage(plan: DeleteToPlayheadPlan, needsReapply: TemplateNeedsReapply[]): string {
  return plan.note && !needsReapply.length ? rippleMessage(`${plan.done}，後面的標題模板也跟著移好`, plan.note)
    : templateEditMessage(plan.done, { needsReapply }, "後面的標題模板也跟著移好");
}

export type TemplateFollowEditActions = ReturnType<typeof createTemplateFollowEditActions>;
