import type { EditProject } from "../domain/types";

function safeDownloadName(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return normalized || "Editkin-project";
}

export function projectDownloadName(project: EditProject, extension: string): string {
  return `${safeDownloadName(project.name)}.${extension}`;
}

export function editGraphFileName(project: EditProject): string {
  return projectDownloadName(project, "editkin.json");
}

export function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadEditGraph(project: EditProject): void {
  downloadTextFile(editGraphFileName(project), JSON.stringify(project, null, 2), "application/json");
}
