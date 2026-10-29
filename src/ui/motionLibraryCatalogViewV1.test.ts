import { describe, expect, it } from "vitest";
import { MOTION_LIBRARY_CATALOG } from "../motionLibrary/catalog";
import { MOTION_LIBRARY_TABS_V1, motionLibraryBadgeV1, motionLibraryCategoriesV1, motionLibraryMatchCountsV1, motionLibraryThumbnailSizeV1,
  searchMotionLibraryV1 } from "./motionLibraryCatalogViewV1";

describe("Motion Library panel catalog view", () => {
  it("offers all 160 items across the three tabs with the catalog's Chinese category names", () => {
    expect(MOTION_LIBRARY_TABS_V1.map(tab => tab.label)).toEqual(["文字動畫", "轉場", "背景"]);
    expect(MOTION_LIBRARY_TABS_V1.map(tab => searchMotionLibraryV1({ kind: tab.kind }).length)).toEqual([80, 40, 40]);
    expect(motionLibraryCategoriesV1("text").map(category => category.names.zh)).toEqual(["衝擊", "流動", "縱深", "切換", "風格", "戲劇", "玩味", "物理", "節奏", "情緒"]);
    expect(motionLibraryCategoriesV1("transition")).toHaveLength(5);
    expect(motionLibraryCategoriesV1("background").map(category => category.names.zh)).toEqual(["網點質感", "方格秩序", "線條速度", "圖形熱鬧", "留白極簡"]);
    expect(searchMotionLibraryV1({ kind: "text", category: "impact" }).map(item => item.id)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08"]);
  });

  it("searches zh, ja and en names, tags, ids and category names; every word must match", () => {
    expect(searchMotionLibraryV1({ kind: "text", query: "爆裂" }).map(item => item.id)).toContain("T01");
    expect(searchMotionLibraryV1({ kind: "text", query: "ワードバースト" }).map(item => item.id)).toEqual(["T01"]);
    expect(searchMotionLibraryV1({ kind: "text", query: "word burst" }).map(item => item.id)).toEqual(["T01"]);
    expect(searchMotionLibraryV1({ kind: "text", query: "per character" }).length).toBeGreaterThan(5);
    expect(searchMotionLibraryV1({ kind: "transition", query: "x09" }).map(item => item.id)).toEqual(["X09"]);
    expect(searchMotionLibraryV1({ kind: "background", query: "網點質感" })).toHaveLength(8);
    expect(searchMotionLibraryV1({ kind: "text", query: "glitch nothing-like-this" })).toEqual([]);
    const counts = motionLibraryMatchCountsV1("wipe");
    expect(counts.transition).toBeGreaterThan(10);
    expect(counts.background).toBe(0);
  });

  it("marks only uncertified art; certified items carry no badge", () => {
    for (const item of MOTION_LIBRARY_CATALOG) expect(motionLibraryBadgeV1(item)).toBe(item.artStatus === "certified" ? undefined : "未認證");
    expect(MOTION_LIBRARY_CATALOG.filter(item => motionLibraryBadgeV1(item))).toEqual([]);
  });

  it("sizes thumbnails to the project's shape", () => {
    expect(motionLibraryThumbnailSizeV1({ width: 1920, height: 1080 })).toEqual({ width: 384, height: 216 });
    expect(motionLibraryThumbnailSizeV1({ width: 1080, height: 1920 })).toEqual({ width: 216, height: 384 });
    expect(motionLibraryThumbnailSizeV1({ width: 1080, height: 1080 }, 300)).toEqual({ width: 300, height: 300 });
  });
});
