import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import type { TimelinePlacementIdFactory } from "./timelinePlacement";
import { trackTemplateFollow } from "./templateFollowProgress";
import { clipHasTemplate, findTimelineClip, hasClipAttachments, planClipMoveWithAttachments, planPlayheadTrimWithTemplates,
  templateFollowGlyphs } from "./timelineMotionEdits";

export const CLIP_MOVE_KEEPS_CHANGING = "專案一直在變動，這次移動沒有套用；請稍後再試一次。";
const CLIP_NOT_FOUND = "找不到這個片段，請重新選取。";
const CLIP_MOVE_FAILED = "無法移動片段。";

export interface AttachedClipMoveHost {
  /** The live project, read when a move is asked for and again when its plan is ready. */
  getProject: () => EditProject;
  /** The editor's own command runner; only an explicit false means the command was refused. */
  runCommand: (command: EditorCommand, successMessage?: string) => boolean | void;
  setStatus: (message: string) => void;
  /** The editor's ordinary move, used unchanged when nothing follows the clip. */
  plainMove: (clipId: string, timelineStart?: number, trackId?: string) => boolean | void;
  makeId: TimelinePlacementIdFactory;
  /** The glyph source a title template moved onto or off 0 s is laid out again with; the real fonts by default. */
  templateGlyphs?: () => ReturnType<typeof templateFollowGlyphs>;
}

/**
 * Start-time and layer edits from the Inspector. A clip that carries titles, captions or a saved title template moves
 * with them in one command, so one Undo. Re-recording a template at its new start takes a moment: the newest request
 * for a clip wins, and a plan made before the project changed is made again on the live project.
 */
export function createAttachedClipMoveActions(host: AttachedClipMoveHost) {
  const latest = new Map<string, number>();
  let requests = 0;

  async function moveWithAttachments(ticket: number, clipId: string, timelineStart?: number, trackId?: string): Promise<boolean> {
    const current = () => latest.get(clipId) === ticket;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = host.getProject();
      const clip = findTimelineClip(project, clipId);
      if (!clip) { host.setStatus(CLIP_NOT_FOUND); return false; }
      let plan: Awaited<ReturnType<typeof planClipMoveWithAttachments>>;
      const glyphs = (host.templateGlyphs ?? templateFollowGlyphs)();
      try {
        plan = await planClipMoveWithAttachments(project, clipId, trackId ?? clip.trackId, timelineStart ?? clip.timelineStart, host.makeId, glyphs);
      } catch (error) {
        if (current()) host.setStatus(error instanceof Error ? error.message : CLIP_MOVE_FAILED);
        return false;
      } finally { glyphs.dispose(); }
      if (!current()) return false;
      if (host.getProject() !== project) continue;
      if (!plan) return host.plainMove(clipId, timelineStart, trackId) !== false;
      return host.runCommand(plan.command, plan.message) !== false;
    }
    if (current()) host.setStatus(CLIP_MOVE_KEEPS_CHANGING);
    return false;
  }

  async function trimWithTemplate(ticket: number, clipId: string, edge: "start" | "end", seconds: number): Promise<boolean> {
    const current = () => latest.get(clipId) === ticket;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = host.getProject();
      let plan: Awaited<ReturnType<typeof planPlayheadTrimWithTemplates>>;
      const glyphs = (host.templateGlyphs ?? templateFollowGlyphs)();
      try { plan = await planPlayheadTrimWithTemplates(project, clipId, edge, seconds, glyphs); }
      catch (error) {
        if (current()) host.setStatus(error instanceof Error ? error.message : CLIP_TRIM_FAILED);
        return false;
      } finally { glyphs.dispose(); }
      if (!current()) return false;
      if (host.getProject() !== project) continue;
      if (!plan) return host.runCommand(playheadTrim(clipId, edge, seconds), PLAYHEAD_TRIM_DONE[edge]) !== false;
      return host.runCommand(plan.command, plan.message) !== false;
    }
    if (current()) host.setStatus(CLIP_TRIM_KEEPS_CHANGING);
    return false;
  }

  return {
    /** True/false at once for a clip nothing follows; a promise when titles or a template move with it. */
    move(clipId: string, timelineStart?: number, trackId?: string): boolean | Promise<boolean> {
      const ticket = ++requests;
      latest.set(clipId, ticket);
      if (!hasClipAttachments(host.getProject(), clipId)) return host.plainMove(clipId, timelineStart, trackId) !== false;
      // A title template may be laid out again: the status line says so if that takes a moment.
      const moving = moveWithAttachments(ticket, clipId, timelineStart, trackId);
      return clipHasTemplate(host.getProject(), clipId) ? trackTemplateFollow(moving) : moving;
    },
    /**
     * The Inspector's in or out point at the playhead (`seconds` trimmed from that edge; the clip keeps its start). A
     * title template on the clip is laid out again on the trimmed clip in the same command; any other clip runs the
     * ordinary trim at once.
     */
    trimAtPlayhead(clipId: string, edge: "start" | "end", seconds: number): boolean | Promise<boolean> {
      const ticket = ++requests;
      latest.set(clipId, ticket);
      if (!clipHasTemplate(host.getProject(), clipId)) return host.runCommand(playheadTrim(clipId, edge, seconds), PLAYHEAD_TRIM_DONE[edge]) !== false;
      return trackTemplateFollow(trimWithTemplate(ticket, clipId, edge, seconds));
    },
  };
}

/** The editor's own messages for the Inspector's in and out points. */
const PLAYHEAD_TRIM_DONE = { start: "已把播放頭設為片段入點。", end: "已把播放頭設為片段出點。" } as const;
const CLIP_TRIM_FAILED = "無法修剪片段。";
const CLIP_TRIM_KEEPS_CHANGING = "專案一直在變動，這次修剪沒有套用；請稍後再試一次。";
function playheadTrim(clipId: string, edge: "start" | "end", seconds: number): EditorCommand {
  return edge === "start" ? { type: "trim_clip_start", clipId, seconds } : { type: "trim_clip_end", clipId, seconds };
}

export type AttachedClipMoveActions = ReturnType<typeof createAttachedClipMoveActions>;
