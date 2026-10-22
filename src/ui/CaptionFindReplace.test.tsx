import { describe, expect, it, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyProject } from "../domain/editGraph";
import { CaptionFindReplace, CaptionMatchExcerpt } from "./CaptionFindReplace";
import { CaptionDelivery } from "./CaptionDelivery";
import { interfacePreferences } from "./i18n/interfacePreferences";

afterEach(async () => { interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });

describe("the real caption search form and delivery entry", () => {
  it("starts with case matching off and shows labelled inputs without changing project/history", () => {
    const project = createEmptyProject("Search form"), before = structuredClone(project);
    const markup = renderToStaticMarkup(<CaptionFindReplace project={project} onCommand={() => { throw Error("No edit on render"); }} onSelect={() => undefined} />);
    expect(markup).toContain("尋找文字"); expect(markup).toContain("取代為");
    expect(markup).not.toContain("checked="); expect(markup).toContain("輸入文字以尋找字幕。");
    expect(project).toEqual(before);
  });

  it("shows a simple-mode sheet entry and an inline advanced form using the same delivery panel", () => {
    const props = { project: createEmptyProject("Delivery"), onCommand: () => undefined, onSelect: () => undefined };
    interfacePreferences.setMode("simple");
    const simple = renderToStaticMarkup(<CaptionDelivery {...props} />);
    expect(simple).toContain("caption-search-open"); expect(simple).not.toContain('data-testid="caption-find-replace"');
    interfacePreferences.setMode("advanced");
    const advanced = renderToStaticMarkup(<CaptionDelivery {...props} />);
    expect(advanced).toContain('data-testid="caption-find-replace"'); expect(advanced).not.toContain("caption-search-open");
  });

  it("highlights original UTF16 text and escapes source HTML, regex punctuation and dollars", () => {
    const html = renderToStaticMarkup(<CaptionMatchExcerpt text={'😀<script>[A].* $& [a].*</script>'} query="[a].*" firstOffset={10} caseSensitive={false} />);
    expect(html).toContain("<mark>[A].*</mark>"); expect(html).toContain("<mark>[a].*</mark>");
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  });

  it("bounds the result DOM even for a giant caption and preserves an emoji at the excerpt boundary", () => {
    const text = "😀" + "x".repeat(100000) + "FIND" + "z".repeat(100000);
    const html = renderToStaticMarkup(<CaptionMatchExcerpt text={text} query="find" firstOffset={100002} caseSensitive={false} />);
    expect(html).toContain("<mark>FIND</mark>"); expect(html.length).toBeLessThan(700); expect(html).toContain("…");
    const boundary = renderToStaticMarkup(<CaptionMatchExcerpt text={"a".repeat(61) + "😀" + "b".repeat(60) + "FIND"} query="FIND" firstOffset={123} caseSensitive />);
    expect(boundary).not.toContain("�");
  });

  it("renders the same form in all five supported interface languages", async () => {
    for (const [locale, label] of [["zh-TW", "尋找文字"], ["en", "Find text"], ["es", "Buscar texto"], ["ja", "検索する文字"], ["ko", "찾을 텍스트"]] as const) {
      await interfacePreferences.setLocale(locale);
      const markup = renderToStaticMarkup(<CaptionFindReplace project={createEmptyProject("Languages")} onCommand={() => undefined} onSelect={() => undefined} />);
      expect(markup).toContain(label);
    }
  });
});
