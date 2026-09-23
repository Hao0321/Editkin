import type { AutomaticCaptionDesktopResult } from "../desktop/types";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";
import { buildAutomaticCaptionCommand } from "./automaticCaptionCommands";
import type { SemanticAutoEditPlan } from "./semanticAutoEdit";

export function buildSemanticAutoEditCommand(
  project: EditProject,
  clip: TimelineClip,
  transcript: Pick<AutomaticCaptionDesktopResult, "cues">,
  plan: SemanticAutoEditPlan,
  idFactory: (kind: "caption" | "segment", index: number) => string = (kind) => makeId(kind === "caption" ? "caption-highlight" : "clip-highlight"),
): { command: EditorCommand; addedCaptions: number; segmentCount: number; segmentIds: string[] } {
  if (!plan.keepRanges.length) throw new Error("智慧成片沒有產生可保留區間");
  const captions = buildAutomaticCaptionCommand(project, clip, transcript, (() => {
    let index = 0;
    return () => idFactory("caption", index++);
  })());
  const segmentIds = plan.keepRanges.map((_, index) => index === 0 ? clip.id : idFactory("segment", index));
  return {
    command: {
      type: "batch",
      commands: [captions.command, { type: "smart_cut_clip", clipId: clip.id, keepRanges: plan.keepRanges, segmentIds }],
    },
    addedCaptions: captions.added,
    segmentCount: plan.keepRanges.length,
    segmentIds,
  };
}
