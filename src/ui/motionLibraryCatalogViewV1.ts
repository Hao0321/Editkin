import { MOTION_LIBRARY_CATALOG, MOTION_LIBRARY_CATEGORIES, type MotionLibraryCategory } from "../motionLibrary/catalog";
import type { MotionLibraryItem } from "../motionLibrary/types";
import type { MotionLibraryTabV1 } from "./motionLibraryUiStoreV1";

/** The panel's tabs, category chips and search over the catalog (names in zh / ja / en, tags, ids and category names). */

export const MOTION_LIBRARY_TABS_V1: ReadonlyArray<{ readonly kind: MotionLibraryTabV1; readonly label: string; readonly hint: string }> = [
  { kind: "text", label: "文字動畫", hint: "拖到軌道上，或按 Enter 加在播放頭" },
  { kind: "transition", label: "轉場", hint: "拖到兩段相接的剪接點上" },
  { kind: "background", label: "背景", hint: "可循環的動態底圖，拖到軌道上" },
];

export function motionLibraryCategoriesV1(kind: MotionLibraryTabV1): readonly MotionLibraryCategory[] {
  return MOTION_LIBRARY_CATEGORIES.filter(category => category.kind === kind);
}

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\s_\-・·／/、，,.。!！?？]+/g, "");
const categoryNames = new Map(MOTION_LIBRARY_CATEGORIES.map(category => [category.id, category]));
const haystacks = new Map(MOTION_LIBRARY_CATALOG.map(item => {
  const category = categoryNames.get(item.category);
  const words = [item.id, item.names.zh, item.names.ja, item.names.en, item.category, ...item.tags, ...item.tags.map(tag => tag.replace(/_/g, " ")),
    ...(category ? [category.names.zh, category.names.ja, category.names.en] : []), item.previewText ?? ""];
  return [item.id, normalize(words.join("\u0001"))];
}));

/** Items of a tab, optionally one category, matching every word of the query (in catalog order). */
export function searchMotionLibraryV1(filter: { kind: MotionLibraryTabV1; category?: string; query?: string }): MotionLibraryItem[] {
  const tokens = (filter.query ?? "").split(/\s+/).map(normalize).filter(Boolean);
  return MOTION_LIBRARY_CATALOG.filter(item => item.kind === filter.kind && item.implemented
    && (!filter.category || item.category === filter.category)
    && tokens.every(token => haystacks.get(item.id)!.includes(token)));
}

/** Matches per tab for a query (shown beside the tab names while searching). */
export function motionLibraryMatchCountsV1(query: string): Readonly<Record<MotionLibraryTabV1, number>> {
  return { text: searchMotionLibraryV1({ kind: "text", query }).length, transition: searchMotionLibraryV1({ kind: "transition", query }).length,
    background: searchMotionLibraryV1({ kind: "background", query }).length };
}

/** Only pending art is marked; certified items carry no badge (PHASE3_INTEGRATION_DESIGN §4). */
export function motionLibraryBadgeV1(item: MotionLibraryItem): string | undefined {
  return item.artStatus === "certified" ? undefined : "未認證";
}

/** Thumbnail size for the project's shape: long side 384 px (sharp at 2× on a ~170 px card). */
export function motionLibraryThumbnailSizeV1(project: { width: number; height: number }, longSide = 384): { width: number; height: number } {
  const aspect = project.width > 0 && project.height > 0 ? project.width / project.height : 16 / 9;
  return aspect >= 1 ? { width: longSide, height: Math.max(16, Math.round(longSide / aspect)) } : { width: Math.max(16, Math.round(longSide * aspect)), height: longSide };
}
