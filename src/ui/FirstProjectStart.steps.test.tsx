import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { FirstProjectStart, FIRST_PROJECT_STEPS } from "./FirstProjectStart";
import { interfacePreferences } from "./i18n/interfacePreferences";

// 2026-10-23 (P6/P7 pack): the welcome card still showed four steps (加入影片 → 剪輯 → 檢查 → 輸出) after the editor's own
// step strip became three (interfaceMessages.70: 三步完成影片). Real React SSR of the card, in advanced mode where it shows.
const noop = () => {};
const render = () => renderToStaticMarkup(<FirstProjectStart isDesktop onImport={noop} onExploreDemo={noop} onHelp={noop} />);
afterEach(async () => { interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });

describe("welcome card step strip", () => {
  it("shows the same three steps as the editor, without 檢查", () => {
    interfacePreferences.setMode("advanced");
    const html = render(), strip = html.slice(html.indexOf('<ol class="first-project-steps"'), html.indexOf("</ol>") + 5);
    expect(FIRST_PROJECT_STEPS).toEqual(["加入影片", "剪輯", "輸出"]);
    expect(strip).toContain('aria-label="三步完成影片"');
    expect(strip.match(/<li>/g)).toHaveLength(3);
    for (const [index, label] of FIRST_PROJECT_STEPS.entries()) expect(strip).toContain(`<b aria-hidden="true">${index + 1}</b><span><strong>${label}</strong>`);
    expect(strip).not.toContain("檢查");
    expect(html).not.toContain("四步完成影片");
  });
  it("names the three steps in the other interface languages", async () => {
    interfacePreferences.setMode("advanced");
    await interfacePreferences.setLocale("en");
    const html = render();
    expect(html).toContain('aria-label="Three steps to your video"');
    expect(html.slice(html.indexOf('<ol class="first-project-steps"'), html.indexOf("</ol>")).match(/<li>/g)).toHaveLength(3);
  });
});
