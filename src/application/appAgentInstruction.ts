import type { Dispatch, SetStateAction } from "react";
import type { useAutomaticEditing } from "../desktop/useAutomaticEditing";
import { compileAgentInstruction, isAutomaticCaptionInstruction, isSceneSplitInstruction, isSemanticAutoEditInstruction, isSmartCutInstruction } from "../domain/agent";
import type { EditorCommand } from "../domain/commands";
import type { EditorHistory } from "../domain/history";
import type { EditProject } from "../domain/types";
import { redo, undo } from "../domain/history";
import { makeId } from "../lib/format";

export interface AppAgentInstructionContext {
  automatic: ReturnType<typeof useAutomaticEditing>;
  project: EditProject;
  selectedClipId?: string;
  selectedCaptionId?: string;
  playhead: number;
  runCommand: (command: EditorCommand, successMessage?: string) => void;
  setHistory: Dispatch<SetStateAction<EditorHistory>>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function submitAppAgentInstruction(instruction: string, context: AppAgentInstructionContext): void {
  if (isSemanticAutoEditInstruction(instruction)) return void context.automatic.semantic.run();
  if (isSceneSplitInstruction(instruction)) return void context.automatic.scenes.run();
  if (isAutomaticCaptionInstruction(instruction)) {
    return void context.automatic.captions.run(/雙語|中英|bilingual/i.test(instruction) ? "bilingual-en" : "original");
  }
  if (isSmartCutInstruction(instruction)) return void context.automatic.smartCut.run();
  try {
    const plan = compileAgentInstruction(
      context.project,
      instruction,
      { selectedClipId: context.selectedClipId, selectedCaptionId: context.selectedCaptionId, playhead: context.playhead },
      makeId("clip"),
    );
    context.runCommand(plan.command, plan.message);
  } catch (error) {
    if (error instanceof Error && error.message === "UNDO_SIGNAL") {
      context.setHistory((current) => undo(current));
      context.setStatus("已復原上一步。");
    } else if (error instanceof Error && error.message === "REDO_SIGNAL") {
      context.setHistory((current) => redo(current));
      context.setStatus("已重做上一步。");
    } else {
      context.setStatus(error instanceof Error ? error.message : "我還不懂這個指令");
    }
  }
}
