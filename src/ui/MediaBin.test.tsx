import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "../domain/types";
import { MediaBin, PROJECT_ASSET_ROW_HEIGHT } from "./MediaBin";

const assets: MediaAsset[] = Array.from({ length: 100 }, (_, index) => ({
  id: `asset-${index}`,
  name: `素材 ${index}`,
  kind: index % 3 === 0 ? "audio" : "video",
  uri: `fixture-${index}.mp4`,
  duration: 3,
}));

describe("compact project media bin", () => {
  it("virtualizes large projects, keeps native wheel scrolling and avoids eager source video decoding", () => {
    const runtimeUrls = Object.fromEntries(assets.map((asset) => [asset.id, `asset://raw/${asset.id}`]));
    const html = renderToStaticMarkup(<MediaBin assets={assets} runtimeUrls={runtimeUrls} onImport={vi.fn()} onAddAssetToTimeline={vi.fn()} onAddAssetAsPictureInPicture={vi.fn()} />);
    const mountedRows = (html.match(/class="asset-row"/g) ?? []).length;
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThanOrEqual(12);
    expect(html).toContain("data-wheel-scroll=\"vertical\"");
    expect(html).toContain("class=\"library-spacer\"");
    expect(html).toContain("class=\"asset-thumb-fallback\"");
    expect(html).not.toContain("<video");
    expect(PROJECT_ASSET_ROW_HEIGHT).toBeLessThanOrEqual(76);
  });

  it("uses verified thumbnails when present and exposes clear timeline/PIP actions", () => {
    const first = assets.find((asset) => asset.kind === "video")!;
    const html = renderToStaticMarkup(<MediaBin assets={[first]} runtimeUrls={{ [`${first.id}:thumbnail`]: "asset://thumb" }} onImport={vi.fn()} onAddAssetToTimeline={vi.fn()} onAddAssetAsPictureInPicture={vi.fn()} />);
    expect(html).toContain('src="asset://thumb"');
    expect(html).toContain(`aria-label="把 ${first.name} 加入時間軸"`);
    expect(html).toContain(`aria-label="把 ${first.name} 加入畫中畫"`);
  });
});
