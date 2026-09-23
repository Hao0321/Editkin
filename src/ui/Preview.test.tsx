import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import type { ActivePreviewLayer } from "../application/previewMedia";
import { Preview } from "./Preview";

function renderNativePreview(state: "ready" | "pending" | "blocked"): string {
  const project = createDemoProject();
  const clip = project.tracks[0].clips[0];
  clip.creative = {
    effectPresetIds: [],
    nativeEffectInstances: [{
      id: "native-1", pluginId: "editkin.test.native", capabilityId: "gain", pluginVersion: "1.0.0",
      manifestSha256: "a".repeat(64), enabled: true, parameters: { gain: 0.8 },
    }],
  };
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId)!;
  const layers: ActivePreviewLayer[] = [{ clip, asset, source: "https://asset.localhost/cache.mp4" }];
  return renderToStaticMarkup(<Preview
    layers={layers}
    audioLayers={[]}
    projectWidth={project.width}
    projectHeight={project.height}
    playhead={0}
    projectDuration={clip.duration}
    projectFps={project.fps}
    captions={[]}
    captionStyle={project.captionStyle}
    project={project}
    nativeEffectPreviewReadyClipIds={state === "ready" ? [clip.id] : []}
    nativeEffectPreviewPendingClipIds={state === "pending" ? [clip.id] : []}
    nativeEffectPreviewErrors={state === "blocked" ? { [clip.id]: "identity mismatch" } : {}}
    playing={false}
    onPlayingChange={() => undefined}
    onPlayheadChange={() => undefined}
  />);
}

describe("native effect preview labels", () => {
  it("scales caption font, outline and margins with the project canvas, not UI pixels", () => {
    const project = createDemoProject();
    project.width = 1080; project.height = 1920;
    project.captions = [{ id: "scaled", text: "清楚可讀，才是重點", start: 0, duration: 2 }];
    project.captionStyle.fontSize = 54; project.captionStyle.outlineWidth = 0;
    project.captionStyle.marginV = 24;
    const html = renderToStaticMarkup(<Preview layers={[]} audioLayers={[]} projectWidth={1080} projectHeight={1920}
      playhead={0.5} projectDuration={2} projectFps={30} captions={project.captions} captionStyle={project.captionStyle}
      project={project} playing={false} onPlayingChange={() => undefined} onPlayheadChange={() => undefined} />);
    expect(html).toContain("container-type:size");
    expect(html).toContain("font-size:5cqw");
    expect(html).toContain("-webkit-text-stroke-width:0cqw");
    expect(html).toContain("paint-order:stroke fill");
    expect(html).toContain("bottom:1.25%");
    expect(html).not.toContain("font-size:27px");
  });
  it("labels a materialized CPU proxy as cache preview rather than resident GPU", () => {
    const html = renderNativePreview("ready");
    expect(html).toContain("CPU 快取預覽");
    expect(html).not.toContain("正式輸出生效");
    expect(html).not.toContain("GPU 直出");
  });

  it("distinguishes generation from a fail-closed preview error", () => {
    expect(renderNativePreview("pending")).toContain("正在建立預覽");
    expect(renderNativePreview("blocked")).toContain("預覽受阻");
  });

  it("does not draw a second DOM caption over an engine-video frame that already composited typography", () => {
    const project = createDemoProject();
    project.captions = [{ id: "native-caption", text: "只應出現一次", start: 0, duration: 2 }];
    const html = renderToStaticMarkup(<Preview
      layers={[]}
      audioLayers={[]}
      projectWidth={project.width}
      projectHeight={project.height}
      playhead={0.5}
      projectDuration={2}
      projectFps={project.fps}
      captions={project.captions}
      captionStyle={project.captionStyle}
      project={project}
      nativeGpuPreview
      gpuPreviewAdmission="engine-video-native"
      playing={false}
      onPlayingChange={() => undefined}
      onPlayheadChange={() => undefined}
    />);
    expect(html).toContain("native-gpu-surface");
    expect(html).not.toContain("只應出現一次");
    expect(html).not.toContain("preview-caption");
  });
});

describe("Preview shared alpha plan admission", () => {
  it("routes an authored mask stack through the closed Canvas executor instead of first-mask CSS", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const base = createClipMask("base", "ellipse");
    const cutout = createClipMask("cutout", "rectangle");
    cutout.mode = "subtract";
    clip.masks = [base, cutout];
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId)!;
    const html = renderToStaticMarkup(<Preview
      layers={[{ clip, asset, source: "alpha-stack-source.mp4" }]}
      audioLayers={[]}
      projectWidth={project.width}
      projectHeight={project.height}
      playhead={0}
      projectDuration={clip.duration}
      projectFps={project.fps}
      captions={[]}
      captionStyle={project.captionStyle}
      project={project}
      playing={false}
      onPlayingChange={() => undefined}
      onPlayheadChange={() => undefined}
    />);
    expect(html).toContain('data-alpha-plan-schema="editkin.clip-alpha-plan/v1"');
    expect(html).toContain('data-testid="preview-video-alpha-source"');
    expect(html).toContain("visibility:hidden");
    expect(html).not.toContain("data:image/svg+xml");
  });

  it("fails visibly before embedding raw media when the formal alpha plan is invalid", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const invalid = createClipMask("invalid-first", "rectangle");
    invalid.mode = "subtract";
    clip.masks = [invalid];
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId)!;
    const html = renderToStaticMarkup(<Preview
      layers={[{ clip, asset, source: "must-not-render-raw.mp4" }]}
      audioLayers={[]}
      projectWidth={project.width}
      projectHeight={project.height}
      playhead={0}
      projectDuration={clip.duration}
      projectFps={project.fps}
      captions={[]}
      captionStyle={project.captionStyle}
      project={project}
      playing={false}
      onPlayingChange={() => undefined}
      onPlayheadChange={() => undefined}
    />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("第一個啟用遮罩必須使用 add");
    expect(html).not.toContain("must-not-render-raw.mp4");
  });

  it("blocks an unsupported video Track Matte instead of silently omitting it", () => {
    const project = createDemoProject();
    const target = project.tracks[0].clips[0];
    const matte = structuredClone(target);
    matte.id = "video-matte";
    target.layer = { enabled: true, role: "content", blendMode: "normal", trackMatte: { sourceClipId: matte.id, mode: "alpha" } };
    const targetAsset = project.assets.find((candidate) => candidate.id === target.assetId)!;
    const matteAsset = { ...targetAsset, id: "video-matte-asset", name: "動態 Matte" };
    matte.assetId = matteAsset.id;
    project.assets.push(matteAsset);
    const html = renderToStaticMarkup(<Preview
      layers={[
        { clip: target, asset: targetAsset, source: "target-must-not-show.mp4" },
        { clip: matte, asset: matteAsset, source: "matte-video.mp4" },
      ]}
      audioLayers={[]}
      projectWidth={project.width}
      projectHeight={project.height}
      playhead={0}
      projectDuration={target.duration}
      projectFps={project.fps}
      captions={[]}
      captionStyle={project.captionStyle}
      project={project}
      playing={false}
      onPlayingChange={() => undefined}
      onPlayheadChange={() => undefined}
    />);
    expect(html).toContain("尚未支援動態影片 Track Matte");
    expect(html).not.toContain("target-must-not-show.mp4");
    expect(html).toContain("matte-video.mp4");
  });
});
