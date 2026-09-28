import type { ActivePreviewLayer } from "../application/previewMedia";

export function nextAutomaticPreviewRepair(
  projectId: string,
  layers: ActivePreviewLayer[],
  failedSources: ReadonlySet<string>,
  attempted: ReadonlySet<string>,
): { assetId: string; attemptKey: string } | undefined {
  for (const { asset, source, clip } of layers) {
    if (asset.kind !== "video" || asset.derivatives?.proxyUri
      || !failedSources.has(JSON.stringify([clip.id, source]))) continue;
    const attemptKey = JSON.stringify([projectId, asset.id, asset.uri, source]);
    if (!attempted.has(attemptKey)) return { assetId: asset.id, attemptKey };
  }
  return undefined;
}
