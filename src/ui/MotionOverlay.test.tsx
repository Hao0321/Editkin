import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createEmptyProject } from "../domain/editGraph";
import type { MotionGraphic } from "../domain/types";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { writeAssContent } from "../render/captionAss";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { motionFontSelection } from "../typography/motionFontReadiness";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
const fonts = vi.hoisted(() => ({ run: undefined as PreparedGlyphRun | undefined }));
// SSR keeps the actual hook: browser font loading is never observed there. A v2
// test that needs painted layout resolves readiness with an authentic factory run.
vi.mock("./useMotionFontReadiness", async importOriginal => {
  const actual = await importOriginal<typeof import("./useMotionFontReadiness")>();
  return { ...actual, useMotionFontReadiness: (...args: Parameters<typeof actual.useMotionFontReadiness>) => {
    const readiness = actual.useMotionFontReadiness(...args);
    return fonts.run ? { selectionKey: readiness.selectionKey, face: readiness.face, status: "ready" as const, glyphRun: fonts.run } : readiness;
  } };
});
import MotionOverlay from "./MotionOverlay";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
afterEach(() => { fonts.run = undefined; });
async function resolveFont(graphic: MotionGraphic): Promise<PreparedGlyphRun> {
  const face = motionFontSelection({ family: graphic.fontFamily ?? "Noto Sans TC", weight: graphic.fontWeight ?? 700, text: graphic.text }).face!;
  fonts.run = await prepareGlyphRun(face.faceId, graphic.text, new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(face.faceId).fontFile))));
  return fonts.run;
}

describe("MotionOverlay v1 project-pixel preview geometry", () => {
  it.skipIf(!existsSync(chrome))("matches authored ASS font and spacing at two letterboxed stage sizes", () => {
    const project = createEmptyProject("v1 preview geometry", { width: 1080, height: 1920, fps: 30 });
    const graphic = createMotionGraphic("scale-v1", "title", "旅遊標題", 0, 3, undefined, legacyMotionGraphicSeed("title"));
    graphic.fontSize = 72;
    graphic.letterSpacing = 6;
    project.motionGraphics = [graphic];
    const formal = writeAssContent(project, project.captionStyle);
    expect(formal).toContain("\\fs72");
    expect(formal).toContain("\\fsp6");
    const markup = renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
    expect(markup).toContain('data-motion-font-status="unobserved"');
    expect(markup).not.toContain('data-motion-font-status="ready"');
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8")
      + readFileSync(join(process.cwd(), "src/ui/motionStudio.css"), "utf8");
    const sandbox = mkdtempSync(join(tmpdir(), "editkin-v1-preview-"));
    try {
      const file = join(sandbox, "fixture.html");
      const stages = [["large", 1000, 600], ["small", 500, 300]] as const;
      const content = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body style="margin:0">${stages.map(([name, width, height]) => `<div id="${name}-viewport" class="preview-viewport" style="width:${width}px;height:${height}px"><div id="${name}-stage" class="preview-stage" style="--canvas-aspect:0.5625">${markup}</div></div>`).join("")}<pre id="metrics"></pre><script>document.querySelector('#metrics').textContent=JSON.stringify(${JSON.stringify(stages.map(([name]) => name))}.map(name=>{const stage=document.querySelector('#'+name+'-stage');const graphic=stage.querySelector('.motion-graphic');const style=getComputedStyle(graphic);return {name,stageWidth:stage.getBoundingClientRect().width,fontSize:Number.parseFloat(style.fontSize),letterSpacing:Number.parseFloat(style.letterSpacing)};}));</script></body></html>`;
      writeFileSync(file, content);
      const output = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(sandbox, "profile")}`, "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 25_000, windowsHide: true, maxBuffer: 2_000_000 });
      const match = output.match(/<pre id="metrics">([^<]+)<\/pre>/);
      expect(match, "Chrome must return actual computed styles").not.toBeNull();
      const metrics = JSON.parse(match![1]) as Array<{ name: string; stageWidth: number; fontSize: number; letterSpacing: number }>;
      expect(metrics).toHaveLength(2);
      for (const item of metrics) {
        expect(item.stageWidth).toBeGreaterThan(0);
        expect(Math.abs(item.fontSize - 72 * item.stageWidth / project.width), JSON.stringify(metrics)).toBeLessThanOrEqual(.5);
        expect(Math.abs(item.letterSpacing - 6 * item.stageWidth / project.width), JSON.stringify(metrics)).toBeLessThanOrEqual(.5);
      }
      expect(Math.abs(metrics[0].stageWidth / metrics[1].stageWidth - 2)).toBeLessThan(.02);
      expect(Math.abs(metrics[0].fontSize / metrics[1].fontSize - 2)).toBeLessThan(.02);
      const oldFixedPx = Math.max(14, graphic.fontSize * .45);
      expect(Math.abs(oldFixedPx - 72 * metrics[1].stageWidth / project.width)).toBeGreaterThan(1);
    } finally {
      // Headless Chrome can briefly hold its profile files on Windows after --dump-dom returns.
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);
});

describe("MotionOverlay v2", () => {
  it("uses the physical alias and exposes substituted weight without synthetic bold", async () => {
    const project=createEmptyProject("font consumer",{width:1920,height:1080,fps:30});
    const g=createMotionGraphic("font","title","TEXT",0,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed);
    g.fontFamily="Fredoka";g.fontWeight=850;project.motionGraphics=[g];
    const ssr=renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false}/>);
    expect(ssr).toContain('data-motion-font-status="unobserved"');expect(ssr).not.toContain('data-motion-font-status="ready"');
    expect(ssr).toContain('data-motion-font-face="EditkinFace-fredoka-700"');expect(ssr).not.toContain('data-testid="motion-glyph-outlines"');
    // Physical outlines of the pinned 700 face replace CSS text, so no browser bold can be synthesized.
    const run=await resolveFont(g);expect(run.faceId).toBe("EditkinFace-fredoka-700");
    const html=renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false}/>);
    expect(html).toContain('data-motion-font-face="EditkinFace-fredoka-700"');expect(html).toContain(`data-motion-font-sha="${bundledFontFaceSpec("EditkinFace-fredoka-700").sha256}"`);
    expect(html).toContain('data-motion-glyph-source="physical-outline"');expect(html).toContain('data-font-weight-substituted="true"');expect(html).toContain("字重 850 → 700");
    expect(html).not.toContain("font-family:");expect(html).not.toContain("font-weight:");expect(html).not.toContain("<span");
  });
  it("renders the exact shared layout receipt and sequenced segments", async () => {
    const project = createEmptyProject("Motion v2", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-v2", "title", "DOM AND EXPORT", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, await resolveFont(graphic));
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain(`data-motion-layout-receipt="${layout.receiptId}"`);
    expect(html.match(/data-motion-segment=/g)).toHaveLength(layout.segments.length);
  });

  it("shows an explicit blocked state instead of silently using v1 layout", async () => {
    const project = createEmptyProject("Motion v2", { width: 320, height: 180, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-blocked", "title", "THIS CANNOT FIT", 0, 3, undefined, preset.seed);
    graphic.width = .05;
    graphic.fontSize = 72;
    graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 72, maxLines: 1 };
    project.motionGraphics.push(graphic);
    await resolveFont(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain("data-testid=\"motion-font-blocked\"");
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("無法在 safe-area 與 1 行內 auto-fit");
    expect(html).not.toContain("data-testid=\"motion-graphic\"");
    expect(html).not.toContain("data-testid=\"motion-glyph-outlines\"");
  });

  it("keeps v2 lower-third tags on their declared width", async () => {
    const project = createEmptyProject("Lower third", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("lower_third_clean_blue_unit");
    const graphic = createMotionGraphic("unit", "tag", "Editkin 創辦人", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    await resolveFont(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-motion-preset="lower_third_clean_blue_unit"');
    expect(html).toContain(`width:${graphic.width * 100}%`);
  });

  it("marks SSR text unobserved and never promotes a custom font to a bundled face", () => {
    const project = createEmptyProject("SSR custom font", { width: 1920, height: 1080, fps: 30 });
    const graphic = createMotionGraphic("custom", "title", "DO NOT SHOW FALLBACK", 0, 3, undefined, legacyMotionGraphicSeed("title"));
    graphic.fontFamily = "Unverified custom font"; project.motionGraphics = [graphic];
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-motion-font-status="unverified"');
    expect(html).toContain('data-testid="motion-font-blocked"');
    expect(html).not.toContain("DO NOT SHOW FALLBACK");
    expect(html).not.toContain("EditkinFace");
  });

  it("keeps vector-only graphics independent of custom or missing browser fonts", () => {
    const project = createEmptyProject("Vector without font", { width: 1920, height: 1080, fps: 30 });
    const graphic = createMotionGraphic("vector", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_disc").seed);
    graphic.fontFamily = "Unverified custom font"; project.motionGraphics = [graphic];
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-testid="motion-vector-v2"');
    expect(html).toContain('data-motion-font-status="not-required"');
    expect(html).not.toContain('data-testid="motion-font-blocked"');
  });
});
