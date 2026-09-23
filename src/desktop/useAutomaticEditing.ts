import type { EditorCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import type { HaoDesktopApi } from "./types";
import type { ProjectSession } from "../application/projectSession";
import { useAutomaticCaptions } from "./useAutomaticCaptions";
import { useSceneDetection } from "./useSceneDetection";
import { useSemanticAutoEdit } from "./useSemanticAutoEdit";
import { useSmartCut } from "./useSmartCut";

interface UseAutomaticEditingOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectSession: ProjectSession;
  selectedClip?: TimelineClip;
  onCommand: (command: EditorCommand, message: string) => void;
  onStatus: (message: string) => void;
  onRuntimeUrls?: (urls: Record<string, string>) => void;
}

export function useAutomaticEditing(options: UseAutomaticEditingOptions) {
  return {
    smartCut: useSmartCut(options),
    captions: useAutomaticCaptions(options),
    scenes: useSceneDetection(options),
    semantic: useSemanticAutoEdit(options),
  };
}
