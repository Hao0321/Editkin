import { describe, expect, it } from "vitest";
import { normalizeWorkspaceLayout, WORKSPACE_PRESETS } from "./workspaceLayout";

describe("modular workspace layout", () => {
  it("defaults to a large-text beginner workspace", () => {
    expect(normalizeWorkspaceLayout(undefined)).toEqual(WORKSPACE_PRESETS.simple);
    expect(WORKSPACE_PRESETS.simple.inspectorVisible).toBe(false);
    expect(WORKSPACE_PRESETS.simple.mediaWidth).toBe(360);
    expect(WORKSPACE_PRESETS.simple.automationVisible).toBe(false);
    expect(WORKSPACE_PRESETS.simple.textSize).toBe("large");
  });

  it("preserves panel choices while clamping unsafe dimensions", () => {
    const layout = normalizeWorkspaceLayout({ preset: "custom", mediaVisible: false, inspectorVisible: true, mediaWidth: 20, inspectorWidth: 900, timelineHeight: 10 });
    expect(layout).toMatchObject({ preset: "custom", mediaVisible: false, inspectorVisible: true, mediaWidth: 220, inspectorWidth: 560, timelineHeight: 170 });
  });

  it("rejects malformed persisted dimensions and visibility instead of emitting NaN CSS", () => {
    const layout = normalizeWorkspaceLayout({ mediaWidth: NaN, inspectorWidth: Infinity, timelineHeight: "broken", mediaVisible: "false", timelineVisible: 0 } as never);
    expect(layout.mediaWidth).toBe(WORKSPACE_PRESETS.simple.mediaWidth);
    expect(layout.inspectorWidth).toBe(WORKSPACE_PRESETS.simple.inspectorWidth);
    expect(layout.timelineHeight).toBe(WORKSPACE_PRESETS.simple.timelineHeight);
    expect(layout.mediaVisible).toBe(true); expect(layout.timelineVisible).toBe(true);
  });
});
