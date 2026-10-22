import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? (next as (old: unknown) => unknown)(hooks.values[i]) : next; }]; },
  useEffect: () => {}, useRef: (current: unknown) => ({ current }) }));
vi.mock("../desktop/useNativeAudioPreviewPlayback", () => ({ useNativeAudioPreviewPlayback: () => ({ mode: "compatible" }) }));
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { Preview } from "./Preview";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset, type TimelineClip } from "../domain/types";
import { proofStillDefaultLayoutV1, type ProofStillV1 } from "../domain/proofStillV1";

function nodes(value: unknown): ReactElement<Record<string, any>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props.children)];
}
const canvas = { width: 1920, height: 1080 };
const proofStill: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: "f".repeat(64), sourceWidth: 1600, sourceHeight: 900,
  crop: { x: 100, y: 100, width: 800, height: 450 }, hold: "static", confirmation: { by: "agent", note: "Account row." },
  redactions: [{ id: "email", rect: { x: 120, y: 120, width: 200, height: 40 }, fill: "#123456" }, { id: "token", rect: { x: 500, y: 400, width: 300, height: 100 }, fill: "#FFFFFF" }] };
function fixture(patch: Partial<TimelineClip> = {}) {
  const project = createEmptyProject("Proof preview", { ...canvas, fps: 30 });
  const asset: MediaAsset = { id: "shot", name: "Settings screenshot", kind: "image", uri: "shots/settings.png", duration: 5, width: 1600, height: 900 };
  const clip: TimelineClip = { id: "proof", assetId: "shot", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 4, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layout: proofStillDefaultLayoutV1(proofStill, canvas), proofStill: structuredClone(proofStill), ...patch };
  project.assets.push(asset); project.tracks[0].clips.push(clip);
  return { project, value: { layers: [{ clip, asset, source: "shot-preview.png" }], audioLayers: [], projectWidth: 1920, projectHeight: 1080, playhead: 1,
    projectDuration: 4, projectFps: 30, captions: [], captionStyle: project.captionStyle, project, playing: false, onPlayingChange: () => {}, onPlayheadChange: () => {} } as any };
}
const render = (value: any) => { hooks.values = []; hooks.index = 0; return Preview(value); };
const percent = (value: string) => Number(value.replace("%", ""));

describe("Preview proof stills (design P3)", () => {
  it("draws the redaction rects over the still in the layout branch, from the compositor's own geometry", () => {
    const tree = nodes(render(fixture().value));
    const image = tree.find(node => node.props["data-testid"] === "preview-image")!;
    // Crop (100,100,800,450) of 1600x900 fitted x1.2 into 1920x1080 → canvas crop (120,120,960,540); the wrapper is that crop.
    expect([image.props.style.left, image.props.style.top, image.props.style.width, image.props.style.height].map(percent).map(v => Math.round(v * 1e4) / 1e4))
      .toEqual([-12.5, -22.2222, 200, 200]);
    expect(image.props.style.objectFit).toBe("fill");
    const rects = tree.filter(node => node.props["data-testid"] === "preview-proof-still-redaction");
    expect(rects.map(rect => rect.props["data-redaction-id"])).toEqual(["email", "token"]);
    // email: source (120,120,200,40) → canvas (144,144,240,48) → crop-relative (2.5%, 4.444%, 25%, 8.889%).
    const email = rects[0].props.style;
    expect([email.left, email.top, email.width, email.height].map(percent).map(v => Math.round(v * 1e3) / 1e3)).toEqual([2.5, 4.444, 25, 8.889]);
    expect(email.background).toBe("#123456");
    expect(rects[1].props.style.background).toBe("#FFFFFF");
    const markup = renderToStaticMarkup(tree.find(node => node.props["data-testid"] === "preview-layout-layer")!);
    expect(markup).toContain('data-testid="preview-proof-still-redaction"');
    expect(markup).toContain("background:#123456");
    // The rects come after the media, so they are painted on top of it.
    expect(markup.indexOf('data-testid="preview-image"')).toBeLessThan(markup.indexOf('data-redaction-id="email"'));
  });

  it.each([
    ["keyframes", { keyframes: [{ id: "k", time: 1, transform: { ...DEFAULT_TRANSFORM, scale: 1.1 }, color: { ...DEFAULT_COLOR }, easing: "linear" as const }] }, "PROOF_STILL_STATIC_HOLD_KEYFRAMES"],
    ["no layout", { layout: undefined }, "PROOF_STILL_LAYOUT_REQUIRED"],
    ["a hand-moved crop", { layout: { crop: { x: 0, y: 0, width: .5, height: .5 }, viewport: { x: 0, y: 0, width: 1, height: 1 } } }, "PROOF_STILL_LAYOUT_CROP_MISMATCH"],
  ])("blocks the layer, never the raw still, when the proof still has %s", (_label, patch, code) => {
    const tree = nodes(render(fixture(patch as Partial<TimelineClip>).value));
    const blocked = tree.find(node => node.props["data-testid"] === "preview-proof-still-blocked")!;
    expect(blocked).toBeDefined();
    expect(JSON.stringify(blocked.props.children)).toContain(code);
    expect(tree.some(node => node.props["data-testid"] === "preview-image" || node.type === "img")).toBe(false);
  });

  it("leaves an ordinary layout clip exactly as before: contain fit, no overlay", () => {
    const { value } = fixture({ proofStill: undefined });
    const tree = nodes(render(value));
    const image = tree.find(node => node.props["data-testid"] === "preview-image")!;
    expect(Object.keys(image.props.style).sort()).toEqual(["height", "left", "objectFit", "position", "top", "width"]);
    expect(image.props.style).toMatchObject({ position: "absolute", objectFit: "contain", width: "200%", height: "200%" });
    expect([image.props.style.left, image.props.style.top].map(percent).map(v => Math.round(v * 1e4) / 1e4)).toEqual([-12.5, -22.2222]);
    expect(tree.some(node => node.props["data-testid"] === "preview-proof-still-redaction")).toBe(false);
  });
});
