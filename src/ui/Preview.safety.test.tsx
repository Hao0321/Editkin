import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? (next as (old: unknown) => unknown)(hooks.values[i]) : next; }]; },
  useEffect: () => {}, useRef: (current: unknown) => ({ current }) }));
vi.mock("../desktop/useNativeAudioPreviewPlayback", () => ({ useNativeAudioPreviewPlayback: () => ({ mode: "compatible" }) }));
// Preview is called directly (no React renderer): the i18n hook reads the store snapshot instead.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { Preview } from "./Preview";
import { createDemoProject } from "../domain/demo";
import { TRANSITION_PRESETS, transitionRenderers } from "../creative/corePack";

function nodes(value: unknown): ReactElement<Record<string, any>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props.children)];
}
function props(patch: Record<string, unknown> = {}) {
  const project = createDemoProject(), clip = project.tracks[0]!.clips[0]!, asset = project.assets[0]!;
  return { project, clip, value: { layers: [{ clip, asset, source: "fixture.mp4" }], audioLayers: [], projectWidth: project.width, projectHeight: project.height, playhead: 0,
    projectDuration: 12, projectFps: project.fps, captions: [], captionStyle: project.captionStyle, project, playing: false,
    onPlayingChange: () => {}, onPlayheadChange: () => {}, ...patch } as any };
}
const render = (value: any) => { hooks.values = []; hooks.index = 0; return nodes(Preview(value)); };

describe("preview errors and flash parity", () => {
  it("keeps a GPU retry beside the preview mode while the GPU preview has a real failure", () => {
    const retry = vi.fn();
    const failed = render(props({ gpuPreviewFailure: "device lost", onRetryGpuPreview: retry }).value);
    const button = failed.find(node => node.props["data-testid"] === "preview-gpu-retry")!;
    expect(button.props.children).toBe("GPU 加速暫停 · 重試");
    expect(button.props.title).toBe("device lost");
    button.props.onClick();
    expect(retry).toHaveBeenCalledOnce();
    expect(failed.find(node => node.props["data-gpu-preview-failure"] === "true")).toBeTruthy();
    expect(render(props().value).some(node => node.props["data-testid"] === "preview-gpu-retry")).toBe(false);
  });

  it("says in the picture area that an effect preview could not be built, with the reason folded", () => {
    const { clip, value } = props();
    const tree = render({ ...value, nativeEffectPreviewErrors: { [clip.id]: "plugin exit 3" } });
    const notice = tree.find(node => node.props["data-testid"] === "native-effect-preview-error")!;
    expect(JSON.stringify(notice)).toContain("特效預覽暫時做不出來");
    expect(JSON.stringify(notice)).toContain("plugin exit 3");
  });

  it("adds a flash with the layer's own SVG filter instead of multiplying with CSS brightness()", () => {
    const flash = TRANSITION_PRESETS.find(preset => transitionRenderers(preset).includes("transition-flash"))!;
    const { clip, value } = props();
    clip.creative = { effectPresetIds: [], transitionIn: { presetId: flash.id, duration: .5 } };
    const atStart = render({ ...value, playhead: clip.timelineStart });
    const video = atStart.find(node => node.type === "video")!;
    expect(video.props.style.filter).toContain("url(#editkin-flash-0-");
    expect(video.props.style.filter).not.toMatch(/brightness\(1\.\d/);
    const filters = atStart.find(node => Array.isArray(node.props.layers))!;
    const markup = renderToStaticMarkup(filters);
    expect(markup).toContain(`id="editkin-flash-0-${clip.id}"`);
    expect(markup).toContain('color-interpolation-filters="sRGB"');
    const midClip = render({ ...value, playhead: clip.timelineStart + 1 }).find(node => node.type === "video")!;
    expect(midClip.props.style.filter).toContain("brightness(1)");
    expect(midClip.props.style.filter).not.toContain("url(");
  });
});
