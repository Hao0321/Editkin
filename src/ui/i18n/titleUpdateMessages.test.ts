import { describe, expect, it } from "vitest";
import { referenceMotionTemplatesUpdateMessage, TEMPLATE_UPDATE_EDITED } from "../../application/referenceMotionTemplateInstances";
import { TEMPLATES_UPDATE_RUNNING } from "../TemplateUpdateNotice";
import { createInterfacePreferencesStore, type UiLocale } from "./interfacePreferences";

// The status-line reports of 「把標題更新到新版」 carry numbers and titles; each one must come out whole in every
// language through the real built locale files (no Chinese left behind, the title kept as typed).
const CJK = /[㐀-鿿]/;
const reports = [
  referenceMotionTemplatesUpdateMessage(3, []),
  referenceMotionTemplatesUpdateMessage(2, [{ title: "Bats" }]),
  referenceMotionTemplatesUpdateMessage(2, [{ title: "Bats" }, { title: "River" }]),
  referenceMotionTemplatesUpdateMessage(0, [{ title: "Bats" }]),
  referenceMotionTemplatesUpdateMessage(0, [{ title: "Bats" }, { title: "River" }]),
  referenceMotionTemplatesUpdateMessage(0, []),
  TEMPLATE_UPDATE_EDITED, TEMPLATES_UPDATE_RUNNING,
  "更新標題模板期間專案已有新修改，未套用舊結果；請以目前版本重新執行。",
];

describe("the title update's status words in every language", () => {
  it.each(["en", "es", "ja", "ko"] as const)("%s", async locale => {
    const store = createInterfacePreferencesStore({});
    expect(await store.setLocale(locale as UiLocale)).toBe(true);
    for (const report of reports) {
      const shown = store.translateStatus(report);
      expect(shown, report).not.toBe(report);
      if (locale === "en" || locale === "es") expect(shown, report).not.toMatch(CJK);
      if (report.includes("Bats")) expect(shown).toContain("Bats");
    }
    expect(store.translateStatus(referenceMotionTemplatesUpdateMessage(2, [{ title: "Bats" }, { title: "River" }]))).toMatch(/2/);
  });
});
