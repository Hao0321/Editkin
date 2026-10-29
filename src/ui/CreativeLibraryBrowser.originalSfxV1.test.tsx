import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CreativeLibraryBrowser from "./CreativeLibraryBrowser";
describe("original SFX opt-in in existing library controls", () => {
  it("does not offer unavailable host generation or alter old controls", () => { const html = renderToStaticMarkup(<CreativeLibraryBrowser />); expect(html).not.toContain('value="original_sfx"'); expect(html).toContain('value="audio"'); expect(html).toContain("搜尋素材"); });
  it("adds only the explicit pending-listening option to the existing dropdown", () => { const html = renderToStaticMarkup(<CreativeLibraryBrowser onLoadOriginalSfxCandidates={async () => undefined} />); expect(html).toContain('value="original_sfx"'); expect(html).toContain("原創音效（待試聽）"); expect(html).not.toContain("已認證原創音效"); });
});
