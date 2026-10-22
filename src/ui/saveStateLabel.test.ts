import { describe, expect, it } from "vitest";
import en from "./i18n/locales/en";
import es from "./i18n/locales/es";
import ja from "./i18n/locales/ja";
import ko from "./i18n/locales/ko";
import { saveStateMessage, saveStateMessageKeys } from "./saveStateLabel";

describe("footer save state", () => {
  it("keeps the advanced wording exactly as the editor shell had it", () => {
    const advanced = { mode: "advanced" as const, hasProjectFile: true };
    expect(saveStateMessage({ ...advanced, isDesktop: false, dirty: true, recoveryState: "idle" })).toBe("未儲存 · 請下載專案 · 無 Autosave");
    expect(saveStateMessage({ ...advanced, isDesktop: false, dirty: false, recoveryState: "idle" })).toBe("專案未變更 · 瀏覽器無 Autosave");
    expect(saveStateMessage({ ...advanced, isDesktop: true, dirty: true, recoveryState: "saved" })).toBe("未儲存 · 當機復原已備份");
    expect(saveStateMessage({ ...advanced, isDesktop: true, dirty: true, recoveryState: "error" })).toBe("未儲存 · 當機復原備份失敗");
    expect(saveStateMessage({ ...advanced, isDesktop: true, dirty: true, recoveryState: "saving" })).toBe("未儲存 · 正在備份當機復原…");
    expect(saveStateMessage({ ...advanced, isDesktop: true, dirty: false, recoveryState: "idle" })).toBe("所有變更已儲存");
    expect(saveStateMessage({ ...advanced, isDesktop: true, dirty: false, recoveryState: "idle", hasProjectFile: false })).toBe("還沒存成專案檔");
  });

  it("says only 已儲存 / 還沒儲存 in simple mode, with no Autosave or crash-recovery words", () => {
    const simple = { mode: "simple" as const, isDesktop: true, hasProjectFile: true };
    expect(saveStateMessage({ ...simple, dirty: false, recoveryState: "idle" })).toBe("已儲存");
    expect(saveStateMessage({ ...simple, dirty: true, recoveryState: "saving" })).toBe("還沒儲存");
    expect(saveStateMessage({ ...simple, dirty: true, recoveryState: "saved" })).toBe("還沒儲存（已自動備份）");
    expect(saveStateMessage({ ...simple, dirty: true, recoveryState: "error" })).toBe("還沒儲存，自動備份也失敗了");
    expect(saveStateMessage({ ...simple, isDesktop: false, dirty: true, recoveryState: "idle" })).toBe("還沒儲存，請下載專案");
    for (const key of saveStateMessageKeys().filter(key => !key.includes("·"))) expect(key).not.toMatch(/Autosave|當機/);
  });

  it("has all five languages for every save state", () => {
    for (const locale of [en, es, ja, ko]) expect(saveStateMessageKeys().filter(key => !(key in locale))).toEqual([]);
  });
});
