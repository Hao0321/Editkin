import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommandSafely, type EditorHistory } from "../domain/history";
import { motionLibraryFixtureProject } from "../domain/motionLibraryV1.fixture";
import { shortcutAction } from "../desktop/useEditorShortcuts";
import type { EditProject } from "../domain/types";
import MotionLibraryInspector from "./MotionLibraryInspector";
import MotionLibraryPanel from "./MotionLibraryPanel";
import { createMotionLibraryControllerV1 } from "./motionLibraryControllerV1";
import { createSimulatedMotionLibraryRenderHostV1 } from "./motionLibrarySimulatedHostV1";
import type { MotionLibraryThumbnailServiceV1 } from "./motionLibraryThumbnailServiceV1";
import { createMotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";
import { TimelineCutPointsV1 } from "./TimelineCutPointsV1";

const service: MotionLibraryThumbnailServiceV1 = { frame: () => new Promise(() => undefined), peek: () => undefined, dispose: () => undefined,
  stats: () => ({ generated: 0, cached: 0, queued: 0, worker: false, meanMs: 0, maxMs: 0, fonts: [] }) };

function setup(project: EditProject = motionLibraryFixtureProject()) {
  let history: EditorHistory = createHistory(project);
  const store = createMotionLibraryUiStoreV1();
  let ids = 0;
  const controller = createMotionLibraryControllerV1({ getProject: () => history.present,
    runCommand: command => { const result = dispatchCommandSafely(history, command, `c${++ids}`); history = result.state; return !result.error; },
    setStatus: () => undefined, getPlayhead: () => 0, getSelectedClipId: () => undefined, selectClip: () => undefined, clearClipSelection: () => undefined,
    store, host: () => createSimulatedMotionLibraryRenderHostV1({ wait: async () => undefined }), makeId: prefix => `${prefix}-${++ids}`, sessionToken: () => 1 });
  return { store, controller, get project() { return history.present; } };
}

describe("動態素材庫 panel markup", () => {
  it("shows the three tabs, the category chips and all 80 text cards as a list (not a listbox, so editor keys keep working)", () => {
    const { store, controller, project } = setup();
    const html = renderToStaticMarkup(<MotionLibraryPanel store={store} controller={controller} service={service} project={project} canRender />);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    for (const label of ["文字動畫", "轉場", "背景", "全部", "衝擊", "情緒"]) expect(html).toContain(label);
    expect(html.match(/data-testid="motion-library-card-T\d\d"/g)).toHaveLength(80);
    expect(html).toContain('role="list"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("未認證");
    expect(html).toContain('aria-keyshortcuts="Enter"');
    expect(html).not.toContain("瀏覽器只能預覽");
  });

  it("filters by search and tab, offers 溶接／黑場 on the transition tab and says when a native render is needed", () => {
    const { store, controller, project } = setup();
    store.setTab("transition");
    store.setQuery("circle");
    const html = renderToStaticMarkup(<MotionLibraryPanel store={store} controller={controller} service={service} project={project} canRender={false} />);
    expect(html).toContain('data-testid="motion-library-card-X09"');
    expect(html).not.toContain('data-testid="motion-library-card-X01"');
    expect(html).toContain("溶接");
    expect(html).toContain("黑場");
    expect(html).toContain("Ctrl+T");
    expect(html).toContain("瀏覽器只能預覽");
    store.setFocusCut({ trackId: "video-main", fromClipId: "a", toClipId: "b" });
    expect(renderToStaticMarkup(<MotionLibraryPanel store={store} controller={controller} service={service} project={project} canRender />))
      .toContain("套用到 00:03.00 的剪接點");
  });
});

describe("動態素材 inspector markup", () => {
  it("text clip: lines, font, 16 themes, a colour well per role, plate, energy, duration and 換一個", async () => {
    const harness = setup();
    await harness.controller.addItem("T05", { trackId: "overlay", startFrame: 0 });
    const clip = harness.project.tracks.flatMap(track => track.clips).find(candidate => candidate.motionLibrary)!;
    const html = renderToStaticMarkup(<MotionLibraryInspector project={harness.project} controller={harness.controller} store={harness.store} service={service}
      target={{ kind: "clip", clip }} canRender />);
    expect(html).toContain("動態素材");
    expect(html.match(/data-testid="motion-library-line-\d"/g)).toHaveLength(3);
    expect(html.match(/class="ml-theme"/g)).toHaveLength(16);
    for (const role of ["bg", "ink", "paper", "accent", "accent2"]) expect(html).toContain(`data-testid="motion-library-color-${role}"`);
    for (const word of ["底板", "透明", "力度", "爆發", "長度", "換一個", "黑體"]) expect(html).toContain(word);
    expect(html).toContain('data-testid="motion-library-reseed"');
  });

  it("transitions: a matte transition gets theme/energy/direction controls; 溶接 gets kind, length and 移除", async () => {
    const harness = setup();
    await harness.controller.applyTransition({ kind: "matte", itemId: "X01" }, { trackId: "video-main", fromClipId: "a", toClipId: "b" });
    const matte = harness.project.timelineTransitions![0];
    const matteHtml = renderToStaticMarkup(<MotionLibraryInspector project={harness.project} controller={harness.controller} store={harness.store} service={service}
      target={{ kind: "transition", transition: matte }} canRender />);
    for (const word of ["方向", "力度", "移除", "X01"]) expect(matteHtml).toContain(word);
    const dissolveProject = applyCommand(motionLibraryFixtureProject(), { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "t1",
      trackId: "video-main", fromClipId: "a", toClipId: "b", beforeFrames: 7, afterFrames: 8, kernel: "dissolve" } });
    const basic = setup(dissolveProject);
    const basicHtml = renderToStaticMarkup(<MotionLibraryInspector project={basic.project} controller={basic.controller} store={basic.store} service={service}
      target={{ kind: "transition", transition: basic.project.timelineTransitions![0] }} canRender />);
    expect(basicHtml).toContain('data-testid="motion-library-transition-inspector"');
    expect(basicHtml).toContain("0.50");
    expect(basicHtml).toContain('aria-keyshortcuts="Delete"');
  });
});

describe("timeline cut points", () => {
  it("draws an applied transition as a 10 px diamond on the cut over its window, with drag edges", () => {
    const project = applyCommand(motionLibraryFixtureProject(), { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "t1",
      trackId: "video-main", fromClipId: "a", toClipId: "b", beforeFrames: 6, afterFrames: 9, kernel: "dissolve" } });
    const { store, controller } = setup(project);
    store.selectTransition("t1");
    const track = project.tracks.find(candidate => candidate.id === "video-main")!;
    const html = renderToStaticMarkup(<TimelineCutPointsV1 project={project} track={track} pixelsPerSecond={60} controller={controller} store={store} />);
    // Window from frame 84 to 99 at 2 px per frame: left 168, width 30; the diamond sits 12 px in (the cut).
    expect(html).toContain("left:168px;width:30px");
    expect(html).toContain('data-testid="timeline-transition-diamond-t1"');
    expect(html).toContain("left:12px");
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/ml-cut-edge/g)).toHaveLength(2);
    // No hover yet: the 18 px add button appears only on hover.
    expect(html).not.toContain("timeline-cut-add-");
  });

  it("Ctrl+T reaches the editor's key owner as apply-transition (never while typing)", () => {
    expect(shortcutAction({ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("apply-transition");
    expect(shortcutAction({ key: "T", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("apply-transition");
    expect(shortcutAction({ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, true)).toBeUndefined();
    expect(shortcutAction({ key: "t", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBeUndefined();
    expect(shortcutAction({ key: "Delete", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe("delete");
    void vi;
  });
});
