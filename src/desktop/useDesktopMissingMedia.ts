import { useEffect, useMemo, useState } from "react";
import type { EditProject, MediaAsset } from "../domain/types";
import type { HaoDesktopApi } from "./apiTypes";
import { RELINK_NO_FINGERPRINT, RELINK_NOT_SAME_FILE } from "../application/plainProblems";
import type { EditorCommand } from "../domain/commands";

/** A media file on this computer (not a library link, a composition or an image sequence). */
export function isLocalMediaFile(asset: MediaAsset): boolean {
  return !asset.compositionId && !asset.imageSequence && (/^[a-z]:[\\/]/i.test(asset.uri) || /^\/[^/]/.test(asset.uri));
}

/**
 * Desktop: the project's media files that are no longer where the project says (moved, renamed or deleted).
 * Checked when the project's media list changes and again when the window comes back into focus.
 */
export function useDesktopMissingMedia(api: Pick<HaoDesktopApi, "checkMediaPaths"> | undefined, project: EditProject, enabled: boolean): MediaAsset[] {
  const candidates = useMemo(() => project.assets.filter(isLocalMediaFile), [project.assets]);
  const key = useMemo(() => JSON.stringify(candidates.map(asset => [asset.id, asset.uri])), [candidates]);
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRevision, setFocusRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !api?.checkMediaPaths) return;
    const refresh = () => setFocusRevision(revision => revision + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [api, enabled]);
  useEffect(() => {
    if (!enabled || !api?.checkMediaPaths || !candidates.length) { setMissingIds(current => current.size ? new Set() : current); return; }
    let current = true;
    void api.checkMediaPaths(candidates.map(asset => asset.uri)).then(present => {
      if (!current || present.length !== candidates.length) return;
      const next = new Set(candidates.filter((_, index) => !present[index]).map(asset => asset.id));
      setMissingIds(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next);
    }, () => undefined);
    return () => { current = false; };
    // `key` carries the asset identity; candidates is its value.
  }, [api, enabled, key, focusRevision]);
  return useMemo(() => candidates.filter(asset => missingIds.has(asset.id)), [candidates, missingIds]);
}

export interface DesktopRelinkInput {
  api: Pick<HaoDesktopApi, "pickRelinkMedia" | "previewUrls">;
  /** The live project at the moment the picked file comes back. */
  getProject: () => EditProject;
  runCommand: (command: EditorCommand, successMessage?: string) => boolean | void;
  mergeRuntimeUrls?: (urls: Record<string, string>) => void;
  rebuildPreview?: (assetId: string) => Promise<void>;
}

/**
 * 「重新找檔案」: the creator picks the moved file; only a byte-identical file (same SHA-256 as when it was
 * imported) is linked back, as one undoable command. Returns false when the picker was closed.
 */
export async function relinkDesktopAsset(input: DesktopRelinkInput, assetId: string): Promise<boolean> {
  const before = input.getProject().assets.find(asset => asset.id === assetId);
  if (!before) return false;
  const expected = before.derivatives?.sourceSha256;
  if ((before.kind !== "video" && before.kind !== "audio") || !expected) throw new Error(RELINK_NO_FINGERPRINT);
  if (!input.api.pickRelinkMedia) throw new Error("這個版本的 Editkin 不能重新連結素材");
  const picked = await input.api.pickRelinkMedia();
  if (picked.canceled) return false;
  if (picked.sha256 !== expected) throw new Error(`${RELINK_NOT_SAME_FILE}: ${picked.path} (${picked.sha256.slice(0, 12)} ≠ ${expected.slice(0, 12)})`);
  const live = input.getProject().assets.find(asset => asset.id === assetId);
  if (!live || live.uri !== before.uri) throw new Error("選檔期間這個素材已被修改，沒有重新連結");
  const ok = input.runCommand({ type: "relink_asset_source", assetId, sourceUri: picked.path, expectedSourceSha256: expected }, `已接回「${before.name}」，剪輯內容沒有改變。`);
  if (ok === false) throw new Error("專案拒絕了這次重新連結");
  const relinked = input.getProject().assets.find(asset => asset.id === assetId);
  if (relinked && input.mergeRuntimeUrls) {
    try { input.mergeRuntimeUrls(await input.api.previewUrls([relinked])); } catch { /* The preview repair below covers it. */ }
  }
  if (relinked?.kind === "video") void input.rebuildPreview?.(assetId);
  return true;
}
