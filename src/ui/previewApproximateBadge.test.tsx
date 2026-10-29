import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { initializeWave2Registry } from "../creative/wave2Registry";
import { AppliedPresetEffectStackV1 } from "./AppliedPresetEffectStackV1";
import { interfacePreferences } from "./i18n/interfacePreferences";

const TOOLTIP = "預覽會用螢幕的解析度套用同一種銳利化，畫面縮小顯示時，邊緣看起來會和輸出檔不完全一樣；實際效果以輸出檔為準。";
const escape = (text: string) => renderToStaticMarkup(<i>{text}</i>).slice(3, -4);

afterAll(async () => { await interfacePreferences.setLocale("zh-TW"); });

describe("「預覽近似」 badge on clips using an ffmpeg-crisp effect", () => {
  it("marks only the crisp rows (scanline_focus and the wave-2 crisp presets) of a clip's applied effects, in all five languages", async () => {
    initializeStudioCreativeAssets(); initializeWave2Registry();
    const ids = ["film_grain_soft", "scanline_focus", "exp26w2_ui_focus_crisp"];
    for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      const html = renderToStaticMarkup(<AppliedPresetEffectStackV1 effectIds={ids} onChange={() => { throw new Error("Render must not dispatch"); }} />);
      const rows = html.split("<article").slice(1);
      expect(rows.map(row => /data-effect-id="([^"]+)"/.exec(row)?.[1])).toEqual(ids);
      expect(rows[0]).not.toContain("preview-approximate-badge");
      const label = interfacePreferences.translate("預覽近似"), tooltip = interfacePreferences.translate(TOOLTIP);
      if (locale !== "zh-TW") { expect(label).not.toBe("預覽近似"); expect(tooltip).not.toBe(TOOLTIP); }
      for (const row of rows.slice(1)) {
        expect((row.match(/data-testid="preview-approximate-badge"/g) ?? []).length).toBe(1);
        expect(row).toContain(`>${escape(label)}</small>`);
        expect(row).toContain(`title="${escape(tooltip)}"`);
      }
      // The row's controls are unchanged: three buttons per effect.
      expect((html.match(/<button /g) ?? []).length).toBe(9);
    }
    for (const id of ["high_key_bloom", "exp26w2_memory_bloom", "studio_detail_pop"]) {
      expect(renderToStaticMarkup(<AppliedPresetEffectStackV1 effectIds={[id]} onChange={() => undefined} />), id).not.toContain("preview-approximate-badge");
    }
  });
});
