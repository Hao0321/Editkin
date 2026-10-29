import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";

// Static markup uses real React; the interaction cases call the production
// component with a stateful hook double (no mounted DOM or browser focus).
const hooks = vi.hoisted(() => ({ active: false, states: [] as { value: unknown }[], index: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useEffect: (...args: Parameters<typeof actual.useEffect>) => hooks.active ? undefined : actual.useEffect(...args),
    useState: (value: unknown) => {
      if (!hooks.active) return actual.useState(value);
      const index = hooks.index++;
      const state = hooks.states[index] ?? (hooks.states[index] = { value: typeof value === "function" ? value() : value });
      return [state.value, (next: unknown) => { state.value = typeof next === "function" ? next(state.value) : next; }];
    } };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { ClipInPointControl } from "./ClipInPointControl";

function project(sourceStart = 2, duration = 3): EditProject {
  const value = createEmptyProject("In-point", { id: "in-point", fps: 30 });
  value.assets = [{ id: "source", name: "Source.mp4", kind: "video", uri: "C:/owned/source.mp4", duration: 10, width: 1920, height: 1080 }];
  value.tracks[0].clips = [{ id: "A", assetId: "source", trackId: "video-main", timelineStart: 1, sourceStart, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } }];
  return validateProject(value);
}
type Props = Record<string, unknown> & { children?: ReactNode };
function find(node: ReactNode, predicate: (props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return undefined; }
  if (!isValidElement<Props>(node)) return undefined;
  if (predicate(node.props)) return node.props;
  return node.props.children ? find(node.props.children, predicate) : undefined;
}
function interactive(value: EditProject) {
  hooks.active = true; hooks.states = [];
  const onCommit = vi.fn(() => true);
  const render = () => { hooks.index = 0; return ClipInPointControl({ project: value, clipId: "A", onCommit }) as ReactNode; };
  const input = () => find(render(), props => props["data-testid"] === "clip-in-point-input")!;
  const type = (text: string) => (input().onChange as (event: object) => void)({ target: { value: text } });
  const key = (name: string) => (input().onKeyDown as (event: object) => void)({ key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const error = () => find(render(), props => props["data-testid"] === "clip-in-point-error");
  return { onCommit, input, type, key, error, done: () => { hooks.active = false; } };
}

describe("Inspector in-point field", () => {
  it("shows the current in-point with the usable range and the Alt-drag shortcut", () => {
    hooks.active = false;
    const html = renderToStaticMarkup(<ClipInPointControl project={project()} clipId="A" onCommit={() => true} />);
    expect(html).toContain("素材入點（從素材第幾秒開始）");
    expect(html).toContain('value="2"');
    expect(html).toContain("可選 0.00–7.00 秒；片段位置和長度不變。");
    expect(html).toContain("也可以在時間軸按住 Alt 拖曳片段。");
    const whole = renderToStaticMarkup(<ClipInPointControl project={project(0, 10)} clipId="A" onCommit={() => true} />);
    expect(whole).toContain("這段已用到整段素材；先把片段剪短，才有空間換入點。");
  });

  it("is disabled with the reason for a clip a title template generated; the template's own main clip can take a new in-point", () => {
    hooks.active = false;
    const owned = (role: { key: string; mainClipId: string }) => applyCommand(project(), { type: "upsert_reference_motion_instance", instance: {
      schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
      input: { templateId: "level_bridge", clipId: role.mainClipId, startFrame: 30, durationFrames: 60, title: "Owned", sources: [],
        intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
      frameFormat: { width: 1920, height: 1080, fps: 30 }, roles: [{ key: role.key, kind: "clip", id: "A", parentId: "video-main" }],
      primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
    } });
    const generated = renderToStaticMarkup(<ClipInPointControl project={owned({ key: "source:1:clip", mainClipId: "elsewhere" })} clipId="A" onCommit={() => true} />);
    expect(generated).toMatch(/<input[^>]*disabled=""/);
    expect(generated).toContain("此片段由模板管理；請透過模板重新編譯或解除模板連結，再換入點。");
    const main = renderToStaticMarkup(<ClipInPointControl project={owned({ key: "source:0:clip", mainClipId: "A" })} clipId="A" onCommit={() => true} />);
    expect(main).not.toMatch(/<input[^>]*disabled=""/);
    expect(main).toContain("可選 0.00–7.00 秒；片段位置和長度不變。");
  });

  it("commits once on Enter, on the nearest project frame", () => {
    const f = interactive(project());
    f.type("4.01");
    f.key("Enter");
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(4);
    f.done();
  });

  it("refuses a start past the end with the latest possible start, and does not commit", () => {
    const f = interactive(project());
    f.type("9");
    f.key("Enter");
    expect(f.onCommit).not.toHaveBeenCalled();
    expect(String(f.error()?.children)).toContain("最晚只能從 7.00 秒開始");
    f.type("");
    (f.input().onBlur as () => void)();
    expect(String(f.error()?.children)).toBe("請輸入入點秒數。");
    f.key("Escape");
    expect(f.input().value).toBe("2");
    expect(f.error()).toBeUndefined();
    f.done();
  });

  it("does nothing when the value did not change", () => {
    const f = interactive(project());
    f.type("2.0");
    f.key("Enter");
    expect(f.onCommit).not.toHaveBeenCalled();
    expect(f.error()).toBeUndefined();
    f.done();
  });
});
