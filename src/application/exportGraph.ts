import type { EditProject } from "../domain/types";
import { encodeProjectBytes } from "./projectCodec";

export interface ProjectDownloadRequest { status: "download_requested"; filename: string; bytes: number }
export const PROJECT_DOWNLOAD_URL_LIFETIME_MS = 15_000;

function safeDownloadName(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return normalized || "Editkin-project";
}

/** Shared byte preparation; callers own the returned URL and must dispose it. */
export function prepareEditGraphDownload(project: EditProject): ProjectDownloadRequest & { url: string; dispose: () => void } {
  const bytes = encodeProjectBytes(project);
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  let disposed = false;
  return Object.freeze({ status: "download_requested", filename: `${safeDownloadName(project.name)}.editkin.json`, bytes: bytes.byteLength, url,
    dispose: () => { if (!disposed) { disposed = true; URL.revokeObjectURL(url); } } });
}

/** Dispatches these exact already-prepared bytes; URL lifetime belongs to the caller. */
export function dispatchPreparedEditGraphDownload(artifact: ProjectDownloadRequest & { url: string }): void {
  const link = document.createElement("a");
  link.href = artifact.url;
  link.download = artifact.filename;
  link.hidden = true;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); }
}

/** Legacy imperative consumer. The App uses its controlled visible lease instead. */
export function downloadEditGraph(project: EditProject): ProjectDownloadRequest {
  const artifact = prepareEditGraphDownload(project);
  const link = document.createElement("a");
  link.href = artifact.url;
  link.download = artifact.filename;
  link.hidden = true;
  let cleaned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener("pagehide", cleanup);
    link.remove();
    artifact.dispose();
  };
  try {
    document.body.appendChild(link);
    window.addEventListener("pagehide", cleanup, { once: true });
    timer = setTimeout(cleanup, PROJECT_DOWNLOAD_URL_LIFETIME_MS);
    link.click();
  } catch (error) { cleanup(); throw error; }
  // Anchor dispatch cannot confirm the browser's download destination or disk write.
  return { status: "download_requested", filename: artifact.filename, bytes: artifact.bytes };
}
