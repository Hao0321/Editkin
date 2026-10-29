import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { planAdjustmentLayerV1 } from "../application/adjustmentLayerPlanV1";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

// P7 (2026-10-23): the timeline's track header switches, inline rename entry, 軌道高度, adjustment clips and ＋ 調整圖層.
const noop = () => {};
function props(patch: Partial<TimelineProps> = {}): TimelineProps {
  return { project: createDemoProject(), duration: 20, playhead: 0, runtimeUrls: {}, onSeek: noop, onSelect: noop, onSelectCaption: noop,
    onMoveClip: noop, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onCommand: () => true,
    onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onToggleHidden: noop,
    onSplit: noop, onDelete: noop, ...patch };
}
afterEach(() => interfacePreferences.setMode("simple"));

describe("timeline track header", () => {
  it("has eye, speaker, solo and lock switches beside every picture track's name, and still says its state to screen readers", () => {
    interfacePreferences.setMode("advanced");
    const value = props();
    value.project = applyCommand(value.project, { type: "toggle_track_lock", trackId: "video-main" });
    const html = renderToStaticMarkup(<Timeline {...value} />);
    expect(html).toContain('data-testid="track-toggles-video-main"');
    expect(html).toContain('aria-label="主畫面 隱藏畫面"');
    expect(html).toContain('aria-label="主畫面 獨奏"');
    expect(html).toMatch(/aria-label="主畫面 鎖定" aria-pressed="true"/);
    expect(html).toContain('<span class="track-locked">已鎖定</span>');
    expect(html).toContain('data-testid="track-toggles-caption-main"');
    expect(html).not.toContain('aria-label="字幕 靜音"');
    expect(html).toMatch(/class="timeline-row track-row"/);
  });
  it("offers 軌道高度 小／中／大 and ＋ 調整圖層 in advanced 更多工具, the latter only with a clip or an I/O range", () => {
    interfacePreferences.setMode("advanced");
    const none = renderToStaticMarkup(<Timeline {...props({ onAddAdjustmentLayer: noop })} />);
    expect(none).toContain('data-track-height="m"');
    for (const size of ["s", "m", "l"]) expect(none).toContain(`data-testid="timeline-track-height-${size}"`);
    expect(none).toMatch(/aria-pressed="true" data-testid="timeline-track-height-m"/);
    expect(none).toMatch(/disabled="" data-testid="timeline-add-adjustment-layer"/);
    expect(renderToStaticMarkup(<Timeline {...props({ onAddAdjustmentLayer: noop, selectedClipId: "clip-demo" })} />)).not.toMatch(/disabled="" data-testid="timeline-add-adjustment-layer"/);
    expect(renderToStaticMarkup(<Timeline {...props({ onAddAdjustmentLayer: noop, markRange: { in: 1, out: 2 } })} />)).not.toMatch(/disabled="" data-testid="timeline-add-adjustment-layer"/);
    expect(renderToStaticMarkup(<Timeline {...props()} />)).not.toContain("timeline-add-adjustment-layer");
    interfacePreferences.setMode("simple");
    expect(renderToStaticMarkup(<Timeline {...props({ onAddAdjustmentLayer: noop })} />)).not.toContain("timeline-add-adjustment-layer");
  });
  it("draws an adjustment layer as a named band with no picture, waveform or volume line of its own", () => {
    interfacePreferences.setMode("advanced");
    const value = props();
    value.project = applyCommand(value.project, planAdjustmentLayerV1(value.project, { selectedClipId: "clip-demo", trackName: "調整圖層" }, prefix => `${prefix}-1`).command);
    value.runtimeUrls = { "asset-demo:thumbnail": "blob:thumb", "asset-demo:waveform": "blob:wave" };
    value.selectedClipId = "adjustment-1";
    const html = renderToStaticMarkup(<Timeline {...value} />);
    const at = html.indexOf('data-testid="timeline-clip-adjustment-1"'), clip = html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
    expect(clip).toContain('class="timeline-clip adjustment selected');
    expect(clip).toContain("<strong>調整圖層</strong>");
    expect(clip).toContain("影響下方 · ");
    expect(clip).not.toContain("blob:thumb"); expect(clip).not.toContain("blob:wave");
    expect(html).toContain('data-testid="timeline-clip-waveform-clip-demo"');
  });
});
