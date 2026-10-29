import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { ClipBlendControlsV1 } from "./ClipBlendControlsV1";
import { ClipLayerHostContextV1, type ClipLayerHostV1 } from "./clipLayerHostV1";
import { interfacePreferences, UI_LOCALES } from "./i18n/interfacePreferences";

// P6 (2026-10-23): real React SSR of the 混合 row through the shell's context, in simple and advanced mode, five languages.
function render(patch: Partial<ClipLayerHostV1> = {}) {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  clip.layer = { enabled: true, blendMode: "multiply" };
  const host: ClipLayerHostV1 = { project, clipId: clip.id, playhead: 3, fps: 30, opacity: .6, onLayerChange: () => true, onOpacityChange: () => true,
    onAddKeyframe: () => {}, onDeleteKeyframe: () => {}, ...patch };
  return renderToStaticMarkup(<ClipLayerHostContextV1.Provider value={host}><ClipBlendControlsV1 clip={clip} /></ClipLayerHostContextV1.Provider>);
}
afterEach(async () => { interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });

describe("調整 › 混合 row in real React", () => {
  it.each(["simple", "advanced"] as const)("renders the same row in %s mode", mode => {
    interfacePreferences.setMode(mode);
    const html = render();
    expect(html).toContain('data-testid="clip-blend-controls"');
    expect(html).toMatch(/data-testid="clip-blend-mode" data-blend-mode="multiply"[^>]*aria-haspopup="listbox" aria-expanded="false"/);
    expect(html).toContain("色彩增值");
    expect(html).toMatch(/<input type="range"[^>]*data-testid="clip-opacity-slider"/);
    expect(html.match(/<input type="range"[^>]*>/)![0]).toContain('value="60"');
    expect(html).toContain('data-testid="clip-opacity-number"');
    expect(html).toMatch(/data-testid="clip-opacity-keyframe" aria-pressed="false"/);
    expect(html).not.toContain('role="listbox"');
  });
  it("renders nothing without the editor's host (a standalone Inspector render)", () => {
    const project = createDemoProject();
    expect(renderToStaticMarkup(<ClipBlendControlsV1 clip={project.tracks[0].clips[0]} />)).toBe("");
  });
  it.each(UI_LOCALES)("names every control in %s", async locale => {
    await interfacePreferences.setLocale(locale);
    const html = render(), t = interfacePreferences.translate;
    for (const words of ["混合", "混合模式", "不透明度", "色彩增值", "在目前時間加入關鍵幀"]) expect(html, words).toContain(t(words));
    // Japanese writes 不透明度 the same way; every other word is translated in every language but zh-TW.
    if (locale !== "zh-TW") for (const words of ["混合模式", "色彩增值", "在目前時間加入關鍵幀", ...(locale === "ja" ? [] : ["不透明度"])]) expect(t(words), words).not.toBe(words);
  });
});
