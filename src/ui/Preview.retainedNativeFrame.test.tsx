import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { Preview } from "./Preview";

// Real product JSX, server rendering only. No mounted/native/pixel evidence.
describe("retained native frame overlay clock", () => {
  function render(nativeGpuPreview: boolean, nativeGpuFrameUpdating: boolean, nativeGpuPresentedFrame?: number, admission?: string) {
    const project = createDemoProject();
    project.captions = [
      { id: "old", text: "已呈現影格的字幕", start: .5, duration: .3 },
      { id: "requested", text: "新要求影格的字幕", start: 1, duration: .5 },
    ];
    return renderToStaticMarkup(<Preview project={project} layers={[]} audioLayers={[]}
      projectWidth={project.width} projectHeight={project.height} projectDuration={2} projectFps={project.fps}
      playhead={1.2} captions={project.captions} captionStyle={project.captionStyle}
      nativeGpuPreview={nativeGpuPreview} nativeGpuFrameUpdating={nativeGpuFrameUpdating}
      nativeGpuPresentedFrame={nativeGpuPresentedFrame} bakedCaptionIds={[]}
      gpuPreviewAdmission={admission}
      playing={false} onPlayingChange={() => undefined} onPlayheadChange={() => undefined} />);
  }
  it("keeps unbaked captions on the actual retained frame and reports the pending seek", () => {
    const html = render(true, true, 18);
    expect(html).toContain("已呈現影格的字幕"); expect(html).not.toContain("新要求影格的字幕");
    expect(html).toContain('data-testid="native-preview-frame-updating"');
    expect(html).toContain('data-gpu-presented-frame="18"');
    expect(html).toContain('data-gpu-frame-updating="true"');
  });
  it("does not layer DOM typography over a pending native-owned whole composition", () => {
    const html = render(true, true, 18, "engine-video-native");
    expect(html).not.toContain("已呈現影格的字幕"); expect(html).not.toContain("新要求影格的字幕");
    expect(html).toContain('data-testid="native-preview-frame-updating"');
  });
  it.each([[true, false, 36], [false, true, 18], [true, true, undefined], [true, true, -1]] as const)(
    "uses the requested time without a valid retained native frame (%s, %s, %s)", (surface, pending, frame) => {
      const html = render(surface, pending, frame);
      expect(html).toContain("新要求影格的字幕"); expect(html).not.toContain("已呈現影格的字幕");
      expect(html).not.toContain('data-testid="native-preview-frame-updating"');
    });
});
