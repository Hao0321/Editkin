import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { writeAssContent } from "../render/captionAss";
import MotionOverlay from "./MotionOverlay";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

describe("MotionOverlay v1 project-pixel preview geometry", () => {
  it.skipIf(!existsSync(chrome))("matches authored ASS font and spacing at two letterboxed stage sizes", () => {
    const project = createEmptyProject("v1 preview geometry", { width: 1080, height: 1920, fps: 30 });
    const graphic = createMotionGraphic("scale-v1", "title", "旅遊標題", 0, 3);
    graphic.fontSize = 72;
    graphic.letterSpacing = 6;
    project.motionGraphics = [graphic];
    const formal = writeAssContent(project, project.captionStyle);
    expect(formal).toContain("\\fs72");
    expect(formal).toContain("\\fsp6");
    const markup = renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false} />);
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
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("MotionOverlay v2", () => {
  it("uses the physical alias and exposes substituted weight without synthetic bold", () => {
    const project=createEmptyProject("font consumer",{width:1920,height:1080,fps:30});
    const g=createMotionGraphic("font","title","TEXT",0,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed);
    g.fontFamily="Fredoka";g.fontWeight=850;project.motionGraphics=[g];
    const html=renderToStaticMarkup(<MotionOverlay project={project} playhead={1} trackingSelectionEnabled={false}/>);
    expect(html).toContain("EditkinFace fredoka 700");expect(html).toContain("font-weight:700");expect(html).toContain("font-synthesis:style");expect(html).toContain('data-font-weight-substituted="true"');
  });
  it("renders the exact shared layout receipt and sequenced segments", () => {
    const project = createEmptyProject("Motion v2", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-v2", "title", "DOM AND EXPORT", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain(`data-motion-layout-receipt="${layout.receiptId}"`);
    expect(html.match(/<span/g)).toHaveLength(layout.segments.length);
  });

  it("shows an explicit blocked state instead of silently using v1 layout", () => {
    const project = createEmptyProject("Motion v2", { width: 320, height: 180, fps: 30 });
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("dom-blocked", "title", "THIS CANNOT FIT", 0, 3, undefined, preset.seed);
    graphic.width = .05;
    graphic.fontSize = 72;
    graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 72, maxLines: 1 };
    project.motionGraphics.push(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.2} trackingSelectionEnabled={false} />);
    expect(html).toContain("data-testid=\"motion-v2-blocked\"");
    expect(html).toContain("v2 排版受阻");
    expect(html).not.toContain("data-testid=\"motion-graphic\"");
  });

  it("keeps v2 lower-third tags on their declared width", () => {
    const project = createEmptyProject("Lower third", { width: 1920, height: 1080, fps: 30 });
    const preset = findMotionGraphicPreset("lower_third_clean_blue_unit");
    const graphic = createMotionGraphic("unit", "tag", "Editkin 創辦人", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.5} trackingSelectionEnabled={false} />);
    expect(html).toContain('data-motion-preset="lower_third_clean_blue_unit"');
    expect(html).toContain(`width:${graphic.width * 100}%`);
  });
});
