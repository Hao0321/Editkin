import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { Preview } from "./Preview";

function renderCanvas(width: number, height: number): string {
  const project = createDemoProject();
  project.width = width;
  project.height = height;
  return renderToStaticMarkup(<Preview
    layers={[]} audioLayers={[]} projectWidth={width} projectHeight={height} playhead={0}
    projectDuration={0} projectFps={project.fps} captions={[]} captionStyle={project.captionStyle}
    project={project} playing={false} onPlayingChange={() => {}} onPlayheadChange={() => {}}
  />);
}

describe("preview canvas aspect ratio", () => {
  it("binds the actual preview stage to landscape and portrait project dimensions", () => {
    const landscape = renderCanvas(1920, 1080);
    const portrait = renderCanvas(1080, 1920);
    expect(landscape).toContain('data-testid="preview-viewport"');
    expect(landscape).toContain('data-canvas-width="1920"');
    expect(landscape).toContain('data-canvas-height="1080"');
    expect(landscape).toContain("aspect-ratio:1920 / 1080");
    expect(portrait).toContain('data-canvas-width="1080"');
    expect(portrait).toContain('data-canvas-height="1920"');
    expect(portrait).toContain("aspect-ratio:1080 / 1920");
  });

  it("uses a centered contain viewport instead of stretching the stage", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.preview-viewport\s*\{[^}]*container-type:\s*size[^}]*place-items:\s*center/s);
    expect(css).toMatch(/\.preview-stage\s*\{[^}]*100cqw[^}]*100cqh[^}]*var\(--canvas-aspect\)/s);
  });
});
