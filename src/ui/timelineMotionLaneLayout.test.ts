import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { MOTION_LANE_COMPACT_BLOCK_HEIGHT, MOTION_LANE_COMPACT_ROW_PITCH, MOTION_LANE_COMPACT_VISIBLE_ROWS, MOTION_LANE_PADDING, MOTION_LANE_ROW_PITCH,
  motionBlockTop, motionLaneHeight, motionLaneLayout, timelineMotionBlocks } from "./timelineMotionBlocks";

/** 主畫面 A [0,4) at 30 fps with `titles` overlapping titles on it (each one second later than the one before). */
function project(titles: number): EditProject {
  const value = createEmptyProject("Compact lane", { id: "compact-lane", width: 1920, height: 1080, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "C:/owned/trip.mp4", duration: 30, width: 1920, height: 1080 }];
  value.tracks[0].clips = [{ id: "A", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } }];
  let result = validateProject(value);
  for (let index = 0; index < titles; index++) {
    result = applyCommand(result, { type: "add_motion_graphic", graphic: createMotionGraphic(`title-${index}`, "title", `第 ${index + 1} 個標題`, index * 0.25, 3) });
  }
  return result;
}

// Measured in headless Chrome at 1280×720, simple mode, Inspector closed and open (.rd/benchmarks/usable-v1-20261009/work/
// layout-1280-20261010): the timeline's scroll area is 188 px tall (173 px when a horizontal scroll bar shows) and every
// track row and the ruler are 52 px.
const SCROLL_AREA_1280x720 = 188, HORIZONTAL_SCROLLBAR = 15, ROW = 52;

describe("the 標題與圖卡 lane in simple mode keeps 主畫面 in view", () => {
  it("keeps the two-line 46 px rows in advanced mode and for a single row", () => {
    const four = timelineMotionBlocks(project(4)), one = timelineMotionBlocks(project(1));
    expect(motionLaneLayout(four, { simple: false })).toEqual({ compact: false, pitch: MOTION_LANE_ROW_PITCH, rows: 4, visibleRows: 4, hidden: 0, overflow: false,
      height: motionLaneHeight(four) });
    expect(motionLaneLayout(one, { simple: true })).toMatchObject({ compact: false, rows: 1, height: 52 });
    expect(motionBlockTop(motionLaneLayout(four, { simple: false }), 3)).toBe(MOTION_LANE_PADDING + 3 * MOTION_LANE_ROW_PITCH);
  });

  it("draws overlapping titles as compact rows: two rows take 62 px", () => {
    const two = timelineMotionBlocks(project(2));
    const layout = motionLaneLayout(two, { simple: true });
    expect(layout).toEqual({ compact: true, pitch: MOTION_LANE_COMPACT_ROW_PITCH, rows: 2, visibleRows: 2, hidden: 0, overflow: false, height: 62 });
    expect(two.map(block => motionBlockTop(layout, block.row))).toEqual([3, 33]);
    // The last row's block ends 3 px above the lane's bottom, like the first one starts 3 px below its top.
    expect(layout.height - (motionBlockTop(layout, 1) + MOTION_LANE_COMPACT_BLOCK_HEIGHT)).toBe(MOTION_LANE_PADDING);
  });

  it("fits the ruler, two title rows and the whole 主畫面 track in the 1280×720 timeline, even with a horizontal scroll bar", () => {
    const layout = motionLaneLayout(timelineMotionBlocks(project(2)), { simple: true });
    expect(ROW + layout.height + ROW).toBeLessThanOrEqual(SCROLL_AREA_1280x720 - HORIZONTAL_SCROLLBAR);
    // The old two-line rows did not: 主畫面 lost most of its row.
    expect(ROW + motionLaneHeight(timelineMotionBlocks(project(2))) + ROW).toBeGreaterThan(SCROLL_AREA_1280x720);
  });

  it("shows two rows and counts the rest behind 「還有 N 個」 until the creator opens them", () => {
    const blocks = timelineMotionBlocks(project(4));
    const closed = motionLaneLayout(blocks, { simple: true }), open = motionLaneLayout(blocks, { simple: true, expanded: true });
    expect(closed).toMatchObject({ compact: true, rows: 4, visibleRows: MOTION_LANE_COMPACT_VISIBLE_ROWS, hidden: 2, overflow: true, height: 62 });
    expect(blocks.filter(block => block.row < closed.visibleRows)).toHaveLength(2);
    expect(open).toMatchObject({ rows: 4, visibleRows: 4, hidden: 0, overflow: true, height: 4 * MOTION_LANE_COMPACT_ROW_PITCH - 4 + 2 * MOTION_LANE_PADDING });
  });

  it("styles the compact blocks as one line and keeps the 「還有 N 個」 button a real, focusable button", () => {
    const css = postcss.parse(readFileSync(new URL("./timelineMotionLane.css", import.meta.url), "utf8"));
    const declarations = (selector: string) => {
      const found: Record<string, string> = {};
      css.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(decl => { found[decl.prop] = decl.value; }); });
      return found;
    };
    expect(declarations(".motion-block.compact")).toMatchObject({ display: "flex", height: `${MOTION_LANE_COMPACT_BLOCK_HEIGHT}px` });
    expect(declarations(".motion-block.compact strong")).toMatchObject({ "min-width": "0" });
    expect(declarations(".motion-lane-more")).toMatchObject({ cursor: "pointer", "min-height": "28px" });
    expect(declarations(".motion-lane-more:focus-visible")).toHaveProperty("outline");
  });
});
