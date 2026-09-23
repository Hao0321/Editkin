import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipMask, type TimelineClip } from "../domain/types";
import MaskStudio from "./MaskStudio";
import { initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";

// Real production component callbacks with persistent hook slots, not browser
// pointer-capture, React scheduling, or delivered-native interaction evidence.
const slots = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (initial: unknown) => {
    const index = slots.index++;
    slots.values[index] ??= { current: initial };
    return slots.values[index];
  },
  useState: (initial: unknown) => {
    const index = slots.index++;
    if (!(index in slots.values)) slots.values[index] = typeof initial === "function" ? initial() : initial;
    return [slots.values[index], (next: unknown) => { slots.values[index] = typeof next === "function" ? next(slots.values[index]) : next; }];
  },
}));

type Element = ReactElement<Record<string, any>>;
function mount() {
  const mask = createClipMask("mask", "subject");
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 12, frameCount: 3,
    sequenceUri: "C:/fixture-only/matte.alpha8", manifestUri: "C:/fixture-only/matte.json",
    framePreviewUris: ["asset://fixture/0", "asset://fixture/1", "asset://fixture/2"],
    meanBoundaryChatter: 0, frozen: true, qualityState: "diagnostic",
  };
  let clip: TimelineClip = { id: "clip", assetId: "asset", trackId: "video", timelineStart: 10, sourceStart: 20, duration: 3, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], masks: [mask] };
  let playhead = 10;
  const onUpdate = vi.fn();
  const noop = vi.fn();
  const target = {
    captured: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() { this.captured = true; },
    hasPointerCapture() { return this.captured; },
    releasePointerCapture() { this.captured = false; },
  };
  const event = { currentTarget: target, pointerId: 1, clientX: 40, clientY: 50 };
  function render() {
    slots.index = 0;
    const elements: Element[] = [];
    let text = "";
    function visit(node: ReactNode): void {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node === "string" || typeof node === "number") { text += String(node); return; }
      if (!isValidElement<Record<string, any>>(node)) return;
      if (typeof node.type === "function") { visit((node.type as (props: Record<string, any>) => ReactNode)(node.props)); return; }
      elements.push(node);
      visit(node.props.children);
    }
    visit(<MaskStudio projectFps={30} playhead={playhead} clip={clip} motionTracks={[]} trackingBusy={false} trackingSelectionActive={false}
      onAdd={noop} onUpdate={onUpdate} onDelete={noop} onBindTrack={noop} onKeyframe={noop} onFreeze={noop}
      onAutoRoto={noop} onQuickAutoRoto={noop} onChromaKeyChange={noop} autoRotoBusy={false}
      autoRotoRuntimeStatus={initialAutoRotoRuntimeStatus(noop)} onBeginMotionTrack={noop} />);
    return { elements, text, svg: elements.find(node => node.type === "svg"), img: elements.find(node => node.type === "img") };
  }
  function ready() {
    render().img!.props.onLoad({ currentTarget: { naturalWidth: 16, naturalHeight: 16 } });
    return render();
  }
  return { mask, onUpdate, event, render, ready,
    at: (time: number) => { playhead = time; },
    changeClip: (patch: Partial<TimelineClip>) => { clip = { ...clip, ...patch }; },
    changeMask: (patch: Partial<ClipMask>) => { Object.assign(mask, patch); },
  };
}
beforeEach(() => { slots.values = []; slots.index = 0; });

describe("MaskStudio time-invalidated matte brush boundary", () => {
  it.each([true, false])("shows reanalysis guidance without wrong-time image or brush (preview URLs=%s)", previews => {
    const ui = mount();
    Object.assign(ui.mask.matteSequence!, { stale: true, staleReason: "clip-time-range-changed" });
    if (!previews) delete ui.mask.matteSequence!.framePreviewUris;
    const view = ui.render();
    expect(view.text).toContain("片段已分割／裁切");
    expect(view.text).toContain("請先重新分析 Auto Roto");
    expect(view.img).toBeUndefined();
    expect(view.svg).toBeUndefined();
    expect(view.elements.some(node => node.type === "button" && node.props.children === "重新分析 Auto Roto" && !node.props.disabled)).toBe(true);
  });

  it("keeps ordinary brush-stale image and consecutive corrections available", () => {
    const ui = mount();
    ui.mask.matteSequence!.stale = true;
    for (let index = 0; index < 2; index += 1) {
      const view = ui.ready();
      expect(view.text).not.toContain("片段已分割／裁切");
      view.svg!.props.onPointerDown(ui.event);
      ui.render().svg!.props.onPointerUp(ui.event);
      expect(ui.onUpdate).toHaveBeenCalledTimes(index + 1);
      Object.assign(ui.mask, ui.onUpdate.mock.calls[index][1]);
    }
    expect(ui.mask.rotoCorrections).toHaveLength(2);
  });

  it.each(["frame", "clip", "source-start", "sequence", "corrections"])("discards a stroke if its %s changes before pointerup", change => {
    const ui = mount();
    ui.ready().svg!.props.onPointerDown(ui.event);
    // 1/12 seconds is still project frame 2 at 30 FPS and therefore matte
    // sample 0 under the shared floor clock. Move to project frame 3 instead.
    if (change === "frame") ui.at(10 + .1);
    if (change === "clip") ui.changeClip({ id: "replacement" });
    if (change === "source-start") ui.changeClip({ sourceStart: 22 });
    if (change === "sequence") ui.mask.matteSequence = { ...ui.mask.matteSequence! };
    if (change === "corrections") ui.mask.rotoCorrections = [{ id: "newer", frame: 0, mode: "foreground", radius: .04, points: [{ x: .2, y: .2 }] }];
    const latest = ui.render();
    if (change === "frame") expect(latest.img!.props.src).toBe("asset://fixture/1");
    latest.svg!.props.onPointerUp(ui.event);
    if (ui.onUpdate.mock.calls.length) console.info(JSON.stringify({ defect: "brush-committed-after-owner-changed", change, patch: ui.onUpdate.mock.calls[0][1] }));
    expect(ui.onUpdate).not.toHaveBeenCalled();
    expect(latest.elements.filter(node => node.type === "polyline")).toHaveLength(change === "corrections" ? 1 : 0);
    ui.ready().svg!.props.onPointerDown(ui.event);
    ui.render().svg!.props.onPointerUp(ui.event);
    expect(ui.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("discards an active stroke when a cut removes the brush surface, including its old closure", () => {
    const ui = mount();
    const old = ui.ready().svg!;
    old.props.onPointerDown(ui.event);
    ui.mask.matteSequence = Object.assign({ ...ui.mask.matteSequence! }, { stale: true, staleReason: "clip-time-range-changed" });
    expect(ui.render().svg).toBeUndefined();
    old.props.onPointerUp(ui.event);
    expect(ui.onUpdate).not.toHaveBeenCalled();
  });

  it("commits a same-frame stroke once and cancels without writing a stroke", () => {
    const ui = mount();
    const start = ui.ready();
    start.svg!.props.onPointerDown(ui.event);
    ui.render().svg!.props.onPointerUp(ui.event);
    ui.render().svg!.props.onPointerUp(ui.event);
    expect(ui.onUpdate).toHaveBeenCalledTimes(1);
    expect(ui.onUpdate.mock.calls[0][1].rotoCorrections[0]).toMatchObject({ frame: 0, points: [{ x: .4, y: .5 }] });
    ui.render().svg!.props.onPointerDown(ui.event);
    ui.render().svg!.props.onPointerCancel(ui.event);
    ui.render().svg!.props.onPointerUp(ui.event);
    expect(ui.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("discards lost pointer capture and ignores another pointer's cancellation", () => {
    const ui = mount();
    ui.ready().svg!.props.onPointerDown(ui.event);
    ui.render().svg!.props.onPointerCancel({ ...ui.event, pointerId: 2 });
    ui.render().svg!.props.onPointerUp(ui.event);
    expect(ui.onUpdate).toHaveBeenCalledTimes(1);
    ui.render().svg!.props.onPointerDown(ui.event);
    ui.render().svg!.props.onLostPointerCapture(ui.event);
    ui.render().svg!.props.onPointerUp(ui.event);
    expect(ui.onUpdate).toHaveBeenCalledTimes(1);
  });
});
