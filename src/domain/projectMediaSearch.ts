import type { MediaAsset } from "./types";

export type ProjectMediaKind = "all" | MediaAsset["kind"];
export type ProjectMediaSort = "imported" | "name" | "duration";
export interface ProjectMediaSearchFilter { query: string; kind: ProjectMediaKind; sort: ProjectMediaSort; }
export const DEFAULT_PROJECT_MEDIA_FILTER: Readonly<ProjectMediaSearchFilter> = Object.freeze({ query: "", kind: "all", sort: "imported" });
export const PROJECT_MEDIA_SEARCH_LIMITS = Object.freeze({ assets: 20_000, metadataBytes: 2*1024*1024, queryCharacters: 128, queryTokens: 12 });
export interface ProjectMediaSearchIndex {
  readonly entries: ReadonlyArray<{ readonly asset: MediaAsset; readonly searchable: string; readonly position: number }>;
}
const encoder = new TextEncoder(), names = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const labels = { video: "video 影片", audio: "audio 音訊 聲音", image: "image 圖片 照片" };
function uriText(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function buildProjectMediaSearchIndex(assets: readonly MediaAsset[]): ProjectMediaSearchIndex {
  if (!Array.isArray(assets) || assets.length > PROJECT_MEDIA_SEARCH_LIMITS.assets) throw Error("專案素材搜尋最多支援 20,000 份素材");
  let bytes = 0, normalizedBytes = 0;
  const ids = new Set<string>();
  const source: readonly MediaAsset[] = assets;
  const entries = source.map((asset, position) => {
    if (!asset || typeof asset.id !== "string" || !asset.id.trim() || /[\u0000-\u001f\u007f]/u.test(asset.id) || asset.id.length > 160 || ids.has(asset.id)
      || typeof asset.name !== "string" || typeof asset.uri !== "string" || !["video", "audio", "image"].includes(asset.kind)
      || asset.name.length > 4096 || asset.uri.length > 8192 || !Number.isFinite(asset.duration) || asset.duration < 0
      || (asset.role !== undefined && (typeof asset.role !== "string" || asset.role.length > 256))) throw Error("專案素材資料無效或 ID 重複");
    ids.add(asset.id);
    const raw = [asset.id, asset.name, asset.uri, asset.role ?? "", labels[asset.kind]].join("\n");
    bytes += encoder.encode(raw).byteLength;
    if (bytes > PROJECT_MEDIA_SEARCH_LIMITS.metadataBytes) throw Error("專案素材搜尋文字超過 2 MiB 預算");
    const searchable = normalize([asset.id, asset.name, uriText(asset.uri), asset.role ?? "", labels[asset.kind]].join("\n"));
    normalizedBytes += encoder.encode(searchable).byteLength;
    if (normalizedBytes > PROJECT_MEDIA_SEARCH_LIMITS.metadataBytes) throw Error("專案素材正規化文字超過 2 MiB 預算");
    return Object.freeze({ asset, searchable, position });
  });
  return Object.freeze({ entries: Object.freeze(entries) });
}
export function searchProjectMedia(index: ProjectMediaSearchIndex, filter: ProjectMediaSearchFilter): MediaAsset[] {
  if (!filter || typeof filter.query !== "string" || filter.query.length > PROJECT_MEDIA_SEARCH_LIMITS.queryCharacters
    || !["all", "video", "audio", "image"].includes(filter.kind) || !["imported", "name", "duration"].includes(filter.sort)) throw Error("素材搜尋條件不合法");
  const tokens = normalize(filter.query).trim().split(/\s+/u).filter(Boolean);
  if (tokens.length > PROJECT_MEDIA_SEARCH_LIMITS.queryTokens) throw Error("素材搜尋最多支援 12 個關鍵字");
  const rows = index.entries.filter(row => (filter.kind === "all" || row.asset.kind === filter.kind) && tokens.every(token => row.searchable.includes(token)));
  if (filter.sort === "name") rows.sort((a,b) => names.compare(a.asset.name,b.asset.name) || a.position-b.position);
  if (filter.sort === "duration") rows.sort((a,b) => b.asset.duration-a.asset.duration || a.position-b.position);
  return rows.map(row => row.asset);
}
