const CREATIVE_URI_PREFIX = "creative://studio.hao.creator-library/";

export function creativeAssetUri(assetId: string): string {
  if (!assetId.trim()) throw new Error("Creative Pack assetId 不可空白");
  return `${CREATIVE_URI_PREFIX}${encodeURIComponent(assetId)}`;
}

export function creativeAssetIdFromUri(uri: string): string | undefined {
  if (!uri.startsWith(CREATIVE_URI_PREFIX)) return undefined;
  const id = decodeURIComponent(uri.slice(CREATIVE_URI_PREFIX.length));
  if (!id.trim() || id.includes("/") || id.includes("\\")) throw new Error("Creative Pack URI 不合法");
  return id;
}
