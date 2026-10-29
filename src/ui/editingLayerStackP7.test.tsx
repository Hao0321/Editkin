import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import type { EditProject, TimelineTrack } from "../domain/types";
import { createLayerTrackDragV1, EditingLayerStackV1 } from "./EditingLayerStackV1";
import { LayerExpressionPanel } from "./LayerExpressionPanel";
import { ClipLayerHostContextV1, type ClipLayerHostV1 } from "./clipLayerHostV1";
import { planAdjustmentLayerV1 } from "../application/adjustmentLayerPlanV1";

// P7 (2026-10-23): the 圖層 panel rows (names, blend, opacity, eye, lock, solo, rename, drag) and the 圖層與表達式 pickers.
function project(): EditProject {
  let value = createDemoProject();
  value = applyCommand(value, { type: "add_track", track: { id: "pip", name: "畫中畫 1", kind: "video", locked: false, muted: false, clips: [] } });
  value = applyCommand(value, { type: "add_clip", clip: { ...structuredClone(value.tracks[0].clips[0]), id: "pip-clip", trackId: "pip", timelineStart: 2, duration: 4,
    transform: { ...value.tracks[0].clips[0].transform, opacity: .6 }, layer: { enabled: false, blendMode: "screen" } } });
  value = applyCommand(value, planAdjustmentLayerV1(value, { selectedClipId: "pip-clip", trackName: "調整圖層" }, prefix => `${prefix}-1`).command);
  return value;
}
const render = (value: EditProject, selection = { kind: "clip" as const, id: "pip-clip" }, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<EditingLayerStackV1 project={value} selection={selection} onSelect={() => {}} onCommand={() => {}} {...extra} />);

describe("圖層 panel rows", () => {
  it("names clips by media and place, with blend, opacity, eye and the adjustment layer by name", () => {
    const value = project(), html = render(value);
    expect(html).toMatch(/data-layer-id="pip-clip" aria-pressed="true"><span class="layer-pick-name">Editkin 示範素材<\/span><small class="layer-pick-detail">00:02.00<\/small>/);
    expect(html).toContain('<small class="layer-badge" title="混合模式">濾色</small>');
    expect(html).toContain('<small class="layer-badge" title="不透明度">60%</small>');
    expect(html).toMatch(/data-testid="layer-clip-enabled-pip-clip" aria-pressed="true"[^>]*aria-label="Editkin 示範素材 隱藏這個圖層"/);
    const adjustment = render(value, { kind: "clip", id: "adjustment-1" });
    expect(adjustment).toMatch(/data-layer-id="adjustment-1" aria-pressed="true"><span class="layer-pick-name">調整圖層</);
  });
  it("gives every track a drag grip, eye/speaker/solo/lock switches, rename, ↑ ↓, and offers ＋調整圖層", () => {
    const value = project(), html = render(value, undefined, { onAddAdjustmentLayer: () => {}, adjustmentLayerReady: true });
    for (const track of value.tracks) {
      expect(html).toContain(`data-layer-track-id="${track.id}"`);
      expect(html).toContain(`data-testid="layer-grip-${track.id}"`);
      expect(html).toContain(`data-testid="track-toggles-${track.id}"`);
      expect(html).toContain(`aria-label="${track.name} 鎖定"`);
    }
    expect(html).toContain('aria-label="重新命名 畫中畫 1"');
    expect(html).toMatch(/data-testid="layer-add-adjustment"[^>]*>.*＋調整圖層/);
    expect(render(value, undefined, { onAddAdjustmentLayer: () => {}, adjustmentLayerReady: false })).toMatch(/data-testid="layer-add-adjustment" disabled=""/);
  });
  it("a locked track keeps its grip still and its clips' eyes read-only", () => {
    const value = applyCommand(project(), { type: "toggle_track_lock", trackId: "pip" });
    const html = render(value);
    expect(html).toMatch(/data-testid="layer-grip-pip" disabled=""/);
    expect(html).toMatch(/data-testid="layer-clip-enabled-pip-clip" aria-pressed="true" disabled=""/);
  });
});

describe("圖層 panel drag reorder", () => {
  const drag = (tracks: TimelineTrack[], hits: Array<string | undefined>) => {
    const targets: Array<string | undefined> = [], drops: Array<[string, string]> = [];
    let hit = 0;
    const controller = createLayerTrackDragV1({ tracks: () => tracks, onTarget: id => targets.push(id), onDrop: (a, b) => drops.push([a, b]), hit: () => hits[hit++] });
    return { controller, targets, drops };
  };
  it("drops a track on another picture track and reports the target while dragging", () => {
    const value = project(), { controller, targets, drops } = drag(value.tracks, ["audio-main", "video-main"]);
    expect(controller.down("adjustment-track-1", 7)).toBe(true);
    controller.move(7, 10, 10); controller.move(7, 10, 40);
    expect(targets).toEqual([undefined, "video-main"]);
    controller.up(7);
    expect(drops).toEqual([["adjustment-track-1", "video-main"]]);
    expect(targets.at(-1)).toBeUndefined();
  });
  it("ignores other pointers and buttons, refuses a locked track, and Esc or a lost capture drops nothing", () => {
    const value = project();
    value.tracks.find(track => track.id === "pip")!.locked = true;
    const { controller, drops } = drag(value.tracks, ["video-main", "video-main"]);
    expect(controller.down("pip", 1)).toBe(false);
    expect(controller.down("adjustment-track-1", 1, 2)).toBe(false);
    expect(controller.down("adjustment-track-1", 1)).toBe(true);
    controller.move(2, 0, 0); controller.up(2);
    expect(drops).toEqual([]);
    controller.move(1, 0, 0); controller.cancel(); controller.up(1);
    expect(drops).toEqual([]);
  });
});

describe("圖層與表達式 pickers", () => {
  it("name clips by media and place instead of raw ids, list picture clips only and no longer carry the blend select", () => {
    let value = project();
    value = applyCommand(value, { type: "import_asset", asset: { id: "voice", name: "旁白.wav", kind: "audio", uri: "D:/owned/voice.wav", duration: 10 } });
    value = applyCommand(value, { type: "add_clip", clip: { ...structuredClone(value.tracks[0].clips[0]), id: "voice-clip", assetId: "voice", trackId: "audio-main", duration: 5 } });
    const clip = value.tracks[0].clips[0];
    const host: ClipLayerHostV1 = { project: value, clipId: clip.id, playhead: 0, fps: 30, onLayerChange: () => true, onOpacityChange: () => true, onAddKeyframe: () => {}, onDeleteKeyframe: () => {} };
    const html = renderToStaticMarkup(<ClipLayerHostContextV1.Provider value={host}><LayerExpressionPanel clip={clip} clips={value.tracks.flatMap(track => track.clips)}
      onLayerChange={vi.fn()} onExpressionChange={vi.fn()} /></ClipLayerHostContextV1.Provider>);
    expect(html).not.toContain('data-testid="layer-blend-mode"');
    expect(html).toContain('<option value="pip-clip">Editkin 示範素材 · 畫中畫 1 00:02.00</option>');
    expect(html).not.toContain('value="voice-clip"');
    expect(html).not.toMatch(/<option value="pip-clip">pip-clip/);
  });
});
