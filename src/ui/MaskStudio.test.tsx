import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import MaskStudio from "./MaskStudio";
import { initialAutoRotoRuntimeStatus, type AutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { createClipMask } from "../domain/masks";

const clip: TimelineClip = {
  id: "clip",
  assetId: "asset",
  trackId: "video-main",
  timelineStart: 0,
  sourceStart: 0,
  duration: 3,
  volume: 1,
  transform: { ...DEFAULT_TRANSFORM },
  color: { ...DEFAULT_COLOR },
  keyframes: [],
};

function renderStudio(autoRotoRuntimeStatus: AutoRotoRuntimeStatus, options: { clip?: TimelineClip; playhead?: number; projectFps?: number } = {}): string {
  const noop = vi.fn();
  return renderToStaticMarkup(<MaskStudio
    playhead={options.playhead ?? 0}
    projectFps={options.projectFps ?? 30}
    clip={options.clip ?? clip}
    motionTracks={[]}
    trackingBusy={false}
    trackingSelectionActive={false}
    onAdd={noop}
    onUpdate={noop}
    onDelete={noop}
    onBindTrack={noop}
    onKeyframe={noop}
    onFreeze={noop}
    onAutoRoto={noop}
    onQuickAutoRoto={noop}
    onChromaKeyChange={noop}
    autoRotoBusy={false}
    autoRotoRuntimeStatus={autoRotoRuntimeStatus}
    onBeginMotionTrack={noop}
  />);
}

describe("MaskStudio Auto Roto runtime truth surface", () => {
  it.each([
    [30, .099, 0], [30, .1, 1], [60, .05, 0], [30_000 / 1_001, 3 * 1_001 / 30_000, 1],
  ])("brush uses the same project-to-matte floor clock at fps=%s time=%s", (projectFps, localTime, expectedFrame) => {
    const mask = createClipMask("clock-mask", "subject");
    mask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
      width: 16, height: 16, analysisFps: 12, frameCount: 8,
      sequenceUri: "C:/fixture/matte.alpha8", manifestUri: "C:/fixture/matte.json",
      framePreviewUris: Array.from({ length: 8 }, (_, index) => `asset://frame-${index}`),
      meanBoundaryChatter: 0, frozen: true, qualityState: "diagnostic",
    };
    const html = renderStudio(initialAutoRotoRuntimeStatus(vi.fn()), {
      projectFps, playhead: 10 + localTime, clip: { ...clip, timelineStart: 10, masks: [mask] },
    });
    expect(html).toContain(`src="asset://frame-${expectedFrame}"`);
    expect(html).toContain(`人工筆刷修正 · 第 ${expectedFrame + 1} 格`);
  });

  it("does not turn an exposed call entry into a built-in or activated claim", () => {
    const html = renderStudio(initialAutoRotoRuntimeStatus(vi.fn()));
    expect(html).toContain("data-runtime-state=\"candidate_diagnostic\"");
    expect(html).toContain("待執行驗證");
    expect(html).toContain("候選檔、測試報告或舊專案都不算目前已啟用");
    expect(html).toContain("成功取得 hash receipt 後才標示已執行");
    expect(html.match(/<button[^>]*data-testid=\"quick-auto-roto\"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).not.toMatch(/已內建|目前 Runtime 已驗證|自研原生時序分割與光學 Alpha 引擎在本機產生/);
    expect(html).not.toMatch(/選擇模型包|安裝模型|重新安裝|影片記憶模型/);
  });

  it("disables one-click Auto Roto when the runtime entry is absent", () => {
    const html = renderStudio(initialAutoRotoRuntimeStatus(undefined));
    expect(html).toContain("data-runtime-state=\"unavailable\"");
    expect(html).toContain("目前不可用");
    expect(html).toMatch(/data-testid=\"quick-auto-roto\"[^>]*disabled/);
    expect(html).toContain("不會假裝已完成逐像素去背");
    expect(html).not.toContain("已內建");
  });

  it("keeps the diagnostic quality boundary visible after runtime activation", () => {
    const active: AutoRotoRuntimeStatus = {
      state: "activated_current",
      canInvoke: true,
      badge: "目前 Runtime 已驗證",
      title: "Auto Roto 已在本次工作階段執行",
      detail: "已收到 1 格、hash 綁定的本機執行 receipt。品質仍是 diagnostic，必須人工檢查；這不代表品質已通過。",
      receipt: {
        engine: "editkin-native-color-temporal-roto/v1",
        routeReceiptSha256: "a".repeat(64),
        sequenceSha256: "b".repeat(64),
        sequenceBytes: 256,
        frameCount: 1,
        qualityState: "diagnostic",
      },
    };
    const html = renderStudio(active);
    expect(html).toContain("data-runtime-state=\"activated_current\"");
    expect(html).toContain("目前 Runtime 已驗證");
    expect(html).toContain("品質仍是 diagnostic");
    expect(html).toContain("這不代表品質已通過");
    expect(html).not.toContain("已內建");
  });
});
