import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { Preview } from "./Preview";
import MotionOverlay from "./MotionOverlay";

describe("current validated native typography ownership", () => {
  it.each([false, true])("keeps DOM captions until the exact current native frame bakes their ID (surface=%s)", nativeGpuPreview => {
    const project = createDemoProject();
    project.captions = [{ id: "caption", text: "保留目前字幕", start: 0, duration: 2 }];
    const render = (bakedCaptionIds: readonly string[]) => renderToStaticMarkup(<Preview project={project}
      layers={[]} audioLayers={[]} projectWidth={project.width} projectHeight={project.height} projectDuration={2}
      playhead={.5} projectFps={project.fps} captions={project.captions} captionStyle={project.captionStyle}
      nativeGpuPreview={nativeGpuPreview} gpuPreviewAdmission="engine-video-native" bakedCaptionIds={bakedCaptionIds}
      playing={false} onPlayingChange={() => undefined} onPlayheadChange={() => undefined} />);
    expect(render([])).toContain("保留目前字幕");
    expect(render(["previous-caption"])).toContain("保留目前字幕");
    expect(render(["caption"]).includes("保留目前字幕")).toBe(!nativeGpuPreview);
  });
  it("removes only baked Motion while retaining tracking controls and the original project", () => {
    const project = createDemoProject();
    project.motionGraphics = ["baked", "unbaked"].map(id => createMotionGraphic(id, "title", id.toUpperCase(), 0, 2,
      undefined, legacyMotionGraphicSeed("title")));
    const before = JSON.stringify(project);
    const html = renderToStaticMarkup(<MotionOverlay project={project} playhead={.5} bakedGraphicIds={["baked"]}
      trackingSelectionEnabled trackingSelection={{ x: .1, y: .2, width: .3, height: .4 }} />);
    expect(html).not.toContain(">BAKED<"); expect(html).toContain(">UNBAKED<");
    expect(html).toContain("tracking-box"); expect(html).toContain("tracking-help");
    expect(JSON.stringify(project)).toBe(before);
  });
});
