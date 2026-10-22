import type { ColorGradeV2 } from "./visualTypes";
import { colorLutDesktopEntryV1Schema, type ColorLutDesktopEntryV1 } from "./colorLutDesktopContractV1";
import { editGradeNodeV1, gradePanelKeyV1, sameGradePanelScopeV1, type GradePanelEditScopeV1 } from "./colorGradePanelEditsV1";
import type { EditProject } from "./types";
import { gradeWorkingSpace } from "../color/gradeV2";
export function setNodeColorLutV1(grade: ColorGradeV2 | undefined, nodeId: string, entry: ColorLutDesktopEntryV1 | undefined, space: "rec709_display" | "acescct", strength = 1) {
  if (entry) { colorLutDesktopEntryV1Schema.parse(entry); if (entry.inputSpace !== space) throw new Error("LUT 色彩空間與目前專案不同，這次未套用。"); }
  return editGradeNodeV1(grade, nodeId, node => { if (entry) node.lut = { id: entry.id, sha256: entry.sha256, strength }; else delete node.lut; return node; });
}
export interface LutPanelContextV1 { clipId: string; nodeId: string; grade?: ColorGradeV2; space: "rec709_display" | "acescct"; editable: boolean; scope?: GradePanelEditScopeV1; readOnly?:boolean }
export function sameLutPanelContextV1(a:LutPanelContextV1,b:LutPanelContextV1){
  if(!b.editable||a.clipId!==b.clipId||a.nodeId!==b.nodeId||a.space!==b.space||gradePanelKeyV1(a.grade)!==gradePanelKeyV1(b.grade)||!sameGradePanelScopeV1(a.scope,b.scope))return false;
  // A ProjectSession may change before React flushes its next render. Check the live owner as well.
  const owner=b.scope?.owner as {getSnapshot?:()=>{sessionId:number;history:{present:EditProject}}}|undefined;
  if(owner?.getSnapshot){const snapshot=owner.getSnapshot();if(snapshot.sessionId!==b.scope?.sessionId)return false;
    const project=snapshot.history.present,track=project.tracks.find(t=>t.clips.some(c=>c.id===b.clipId)),clip=track?.clips.find(c=>c.id===b.clipId);
    if(!clip||track?.locked&&!b.readOnly||gradePanelKeyV1(clip.gradeV2)!==gradePanelKeyV1(b.grade)||gradeWorkingSpace(project.colorManagement)!==b.space)return false;
  }
  return true;
}
