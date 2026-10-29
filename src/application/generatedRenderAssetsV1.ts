import { applyCommand } from "../domain/commands";
import { STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1 } from "../domain/styleJobV1";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MediaAsset } from "../domain/types";

/**
 * Renders Editkin made itself: a style template clip (`…/styletpl-clip/<template>/<key>.mov`) or a Motion Library clip,
 * matte or overlay (`…/motionlib/<item>/<key>….mov`). They are cache files bound to their clip or transition, never
 * the creator's original media, so a clip's removal may take its render with it (L1/G7). Browser-safe and pure.
 */
const RENDER_DIRECTORIES: ReadonlySet<string> = new Set([STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1, "motionlib"]);

export function isGeneratedRenderAssetV1(asset: Pick<MediaAsset, "kind" | "uri" | "compositionId" | "imageSequence">): boolean {
  if (asset.kind !== "video" || asset.compositionId !== undefined || asset.imageSequence !== undefined) return false;
  const parts = asset.uri.split(/[\\/]+/);
  return parts.length >= 3 && RENDER_DIRECTORIES.has(parts.at(-3)!) && /\.mov$/i.test(parts.at(-1)!);
}

/** Whether anything in the project other than the asset record itself still names the asset. */
export function projectReferencesAssetV1(project: EditProject, assetId: string): boolean {
  const { assets: _assets, ...rest } = project;
  return JSON.stringify(rest).includes(JSON.stringify(assetId));
}

/**
 * The commands that remove one generated clip (or a transition) and, in the same Undo, every render of it nothing else
 * still uses. Renders shared with another clip stay; original media is never removed here.
 */
export function generatedRemovalCommandsV1(project: EditProject, removal: EditorCommand, renderAssetIds: readonly string[]): EditorCommand[] {
  const after = applyCommand(project, structuredClone(removal));
  const unused = [...new Set(renderAssetIds)].filter(id => {
    const asset = project.assets.find(candidate => candidate.id === id);
    return asset !== undefined && isGeneratedRenderAssetV1(asset) && !projectReferencesAssetV1(after, id);
  });
  return [removal, ...unused.map((assetId): EditorCommand => ({ type: "delete_asset", assetId }))];
}

/**
 * Original media survive every plan: each asset of `before` is still in `after` with the same file. The one exception is
 * a render Editkin made that left together with the last record naming it (a removed template or Motion Library clip).
 */
export function assertOriginalAssetsKeptV1(before: EditProject, after: EditProject, refusal: (assetId: string) => string): void {
  for (const asset of before.assets) {
    const current = after.assets.find(candidate => candidate.id === asset.id);
    if (!current && isGeneratedRenderAssetV1(asset) && !projectReferencesAssetV1(after, asset.id)) continue;
    if (!current || current.uri !== asset.uri) throw new Error(refusal(asset.id));
  }
}
