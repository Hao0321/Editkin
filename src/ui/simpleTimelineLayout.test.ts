import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { MOTION_LANE_PADDING, MOTION_LANE_ROW_PITCH } from "./timelineMotionBlocks";
import { SIMPLE_TIMELINE_HEIGHT, WORKSPACE_PRESETS } from "./workspaceLayout";

// Source guards for the simple-mode timeline; the rendered geometry was measured in headless Chromium at 1440×900 and
// 1280×720 (.rd/benchmarks/usable-v1-20261009/work/simple-polish-20261010). Measured there: the one-row timeline
// toolbar is 67px with its border, every timeline row 52px, the horizontal scroll bar 15px, the shell border 1px; the
// preview needs its 46px header, a 160px picture, 10px padding and the 44px 播放 row.
const TOOLBAR = 67, ROW = 52, SCROLLBAR = 15, BORDER = 1;
const PREVIEW_MINIMUM = 46 + 160 + 10 + 44 + 1;

function rules(css: string, selector: string, media?: string): Rule[] {
  const found: Rule[] = [];
  postcss.parse(css).walkRules(rule => {
    const parent = rule.parent?.type === "atrule" ? `${(rule.parent as { params: string }).params}` : undefined;
    if (rule.selector === selector && parent === media) found.push(rule);
  });
  return found;
}
const declaration = (rule: Rule | undefined, property: string) => {
  let value: string | undefined;
  rule?.walkDecls(property, entry => { value = entry.value.replace(/\s+/g, ""); });
  return value;
};

describe("simple-mode timeline keeps 標題與圖卡 and 主畫面 in view", () => {
  it("is tall enough for the ruler, a two-row titles lane, the main track and a scroll bar", () => {
    const twoRowLane = 2 * MOTION_LANE_ROW_PITCH + 2 * MOTION_LANE_PADDING;
    expect(WORKSPACE_PRESETS.simple.timelineHeight).toBe(SIMPLE_TIMELINE_HEIGHT);
    expect(BORDER + TOOLBAR + ROW + twoRowLane + ROW + SCROLLBAR).toBeLessThanOrEqual(SIMPLE_TIMELINE_HEIGHT);
    // The other presets are unchanged.
    expect(WORKSPACE_PRESETS.edit.timelineHeight).toBe(326);
  });

  it("puts the timeline's name and buttons in one row, keeps 播放 in one row and gives a short window's preview its minimum", () => {
    const css = readFileSync(new URL("./accessibleWorkspace.css", import.meta.url), "utf8");
    expect(declaration(rules(css, '.app-shell[data-interface-mode="simple"] .timeline-actions')[0], "flex")).toBe("11560px");
    expect(declaration(rules(css, '.app-shell[data-interface-mode="simple"] .playback-controls-actions')[0], "flex")).toBe("11auto");
    const short = rules(css, '.app-shell[data-interface-mode="simple"][data-workspace-mode="editor"]', "(max-height: 760px)")[0];
    const rows = declaration(short, "grid-template-rows");
    expect(rows).toBe("autominmax(266px,1fr)minmax(170px,var(--timeline-height,200px))auto");
    expect(Number(rows?.match(/minmax\((\d+)px,1fr\)/)?.[1])).toBeGreaterThanOrEqual(PREVIEW_MINIMUM);
    // Hidden only on a short window, and only the duplicate title: the big 加入更多素材 button stays.
    expect(declaration(rules(css, '.app-shell[data-interface-mode="simple"][data-workspace-mode="editor"] .media-bin > .panel-title', "(max-height: 760px)")[0], "display")).toBe("none");
  });
});
