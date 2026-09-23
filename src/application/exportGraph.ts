import type { EditProject } from "../domain/types";

function safeDownloadName(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return normalized || "Editkin-project";
}

export function downloadEditGraph(project: EditProject): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeDownloadName(project.name)}.editkin.json`;
  link.click();
  URL.revokeObjectURL(url);
}
