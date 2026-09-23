import type { EditProject } from "../domain/types";
import { renderProject, type RenderOptions, type RenderResult } from "../render/ffmpeg";

export interface ExportVideoRequest {
  project: EditProject;
  outputPath: string;
  options?: RenderOptions;
}

export async function exportVideo(request: ExportVideoRequest): Promise<RenderResult> {
  return renderProject(request.project, request.outputPath, request.options);
}
