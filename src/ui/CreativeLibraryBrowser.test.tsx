import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";
import CreativeLibraryBrowser, { CREATIVE_LIBRARY_ROW_HEIGHT } from "./CreativeLibraryBrowser";
const deferredSearch=vi.hoisted(()=>({value:undefined as string|undefined}));
vi.mock("react",async importOriginal=>({...await importOriginal<typeof import("react")>(),useDeferredValue:(value:string)=>deferredSearch.value??value}));

const library: CreativeLibrarySummary = {
  id: "studio.hao.fixture",
  name: "Fixture Pack",
  version: "1.0.0",
  attribution: "Fixture",
  assetCount: 3,
  assetBytes: 1024,
  musicAssetCount: 1,
  sfxAssetCount: 0,
  restrictedAssetCount: 0,
  assets: [
    { id: "video:1", name: "真實 B-roll", category: "broll", role: "support", domains: ["tutorial"], mediaKind: "video", bytes: 512, license: "CC0-1.0", provenance: "fixture" },
    { id: "image:1", name: "重點圖卡", category: "graphic", role: "callout", domains: ["tutorial"], mediaKind: "image", bytes: 256, license: "CC0-1.0", provenance: "fixture" },
    { id: "music:1", name: "節奏配樂", category: "music", role: "background-music", domains: ["shorts"], mediaKind: "audio", bytes: 256, bpm: 118, license: "CC0-1.0", provenance: "fixture" },
  ],
};

describe("CreativeLibraryBrowser", () => {
  it("exposes a typed readiness contract for packaged-product smoke tests",()=>{
    const ready=renderToStaticMarkup(<CreativeLibraryBrowser library={library}/>);
    expect(ready).toContain('data-library-count="3"');
    expect(ready).toContain('data-library-total="3"');
    expect(ready).toContain('data-library-loading="false"');
    const loading=renderToStaticMarkup(<CreativeLibraryBrowser library={library} loading/>);
    expect(loading).toContain('data-library-loading="true"');
  });
  it("uses one accessible native type selector retaining all seven categories",()=>{const html=renderToStaticMarkup(<CreativeLibraryBrowser library={library}/>);expect(html).toContain('<select class="library-kind-select" aria-label="素材類型">');expect((html.match(/<option /g)??[])).toHaveLength(7);for(const label of ["全部","補充畫面","轉場","動態素材","私人動畫","音訊","圖片"])expect(html).toContain(label);expect(html).not.toContain("library-kind-tabs");});
  it("matches the actual original filename even when the curated display name differs",()=>{
    const named={...library,assets:library.assets.map((asset,i)=>i===0?{...asset,sourceFilename:"VID_20260423151917318.mp4"}:asset)};
    deferredSearch.value="vid_20260423151917318";
    try{const html=renderToStaticMarkup(<CreativeLibraryBrowser library={named}/>);expect(html).toContain("1 項素材，可持續捲動");expect(html).toContain("真實 B-roll");expect(html).not.toContain("重點圖卡");}finally{deferredSearch.value=undefined;}
  });
  it("bounds mounted cards to eight and provides continuous scroll rather than sixty-only or paging", () => {
    const many = {...library, assetCount: 65, assets: Array.from({length:65},(_,i)=>({...library.assets[0]!,id:`v:${i}`,name:`素材 ${i}`}))};
    const html=renderToStaticMarkup(<CreativeLibraryBrowser library={many}/>);
    expect((html.match(/class="creative-asset-card"/g)??[]).length).toBeLessThanOrEqual(8);
    expect(html).toContain("65 項素材，可持續捲動");
    expect(html).toContain("library-spacer");
    expect(html).not.toContain("下一頁");
    expect(html).toContain(`style="height:${CREATIVE_LIBRARY_ROW_HEIGHT-10}px"`);
  });
  it("keeps the library simple, preview-led, and independently scrollable", () => {
    const html = renderToStaticMarkup(<CreativeLibraryBrowser library={library} onResolvePreview={async () => "asset://fixture"} onImport={() => undefined} onAutoMusic={() => undefined} />);
    expect(html).toContain("內建素材");
    expect(html).toContain("智慧配樂");
    expect(html).toContain("data-testid=\"creative-library-scroll\"");
    expect(html).toContain("data-wheel-scroll=\"vertical\"");
    expect(html).toContain("class=\"library-filter-row\"");
    expect(html).toContain("tabindex=\"0\"");
    expect(html).toContain("真實 B-roll");
    expect(html).toContain("aria-label=\"加入 真實 B-roll\"");
    expect(html).not.toContain("素材庫預覽");
    expect(html).not.toContain("一次顯示 60 筆保持流暢");
    expect(CREATIVE_LIBRARY_ROW_HEIGHT).toBeLessThanOrEqual(144);
  });

  it("shows a real audio preview control with BPM instead of an empty tile", () => {
    const html = renderToStaticMarkup(<CreativeLibraryBrowser library={library} onAudioPreview={() => undefined} />);
    expect(html).toContain("aria-label=\"預聽 節奏配樂\"");
    expect(html).toContain("118 BPM");
  });

  it("uses an explicit remote placeholder instead of an endless preview shimmer without a resolver", () => {
    const html = renderToStaticMarkup(<CreativeLibraryBrowser library={library} />);
    expect(html).toContain("桌面版可顯示預覽");
    expect(html).toContain("遠端模式仍可瀏覽素材資訊");
    expect(html).toContain("需由桌面版加入");
    expect(html).not.toContain("<b>載入預覽</b>");
    expect(html).not.toContain("aria-busy=\"true\"");
  });
});
