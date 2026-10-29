import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_MEDIA_FILTER, type ProjectMediaSearchFilter } from "../domain/projectMediaSearch";
import type { MediaAsset } from "../domain/types";
import en from "./i18n/locales/en";
import es from "./i18n/locales/es";
import ja from "./i18n/locales/ja";
import ko from "./i18n/locales/ko";
import { MediaBin } from "./MediaBin";
import { PROJECT_MEDIA_SEARCH_FOLD_MAX, ProjectMediaSearchControls, projectMediaSearchExpanded } from "./ProjectMediaSearchControls";

const plain: ProjectMediaSearchFilter = { ...DEFAULT_PROJECT_MEDIA_FILTER };
const controls = (total: number, filter: ProjectMediaSearchFilter = plain) =>
  renderToStaticMarkup(<ProjectMediaSearchControls filter={filter} found={total} total={total} onChange={vi.fn()} />);
const assets = (count: number): MediaAsset[] => Array.from({ length: count }, (_, index) => ({
  id: `asset-${index}`, name: `片段 ${index}`, kind: "video", uri: `clip-${index}.mp4`, duration: 3,
}));

describe("project media search on small projects", () => {
  it("waits behind one small 搜尋素材 button for one to six assets", () => {
    expect(PROJECT_MEDIA_SEARCH_FOLD_MAX).toBe(6);
    for (const total of [1, 3, 6]) {
      const html = controls(total);
      expect(html, `${total}`).toContain('data-collapsed="true"');
      expect(html).toMatch(/data-testid="project-media-search-open"[^>]*aria-expanded="false"/);
      expect(html).toContain("搜尋素材");
      expect(html).not.toContain('type="search"');
      expect(html).not.toContain("<select");
    }
  });

  it("shows nothing at all while there is nothing to search", () => {
    expect(controls(0)).toBe("");
  });

  it("shows the full search for more than six assets, or while a filter is in use", () => {
    const many = controls(7);
    expect(many).not.toContain("data-collapsed");
    expect(many).toContain('type="search"');
    expect(many).not.toContain("project-media-search-close");
    for (const filter of [{ ...plain, query: "海" }, { ...plain, kind: "audio" as const }, { ...plain, sort: "name" as const }]) {
      const html = controls(3, filter);
      expect(html).toContain('type="search"');
      // A filter in use cannot be folded away: hidden filtering would hide clips without saying why.
      expect(html).not.toContain("project-media-search-close");
    }
    expect(projectMediaSearchExpanded(3, plain, true)).toBe(true);
    expect(projectMediaSearchExpanded(3, plain, false)).toBe(false);
    expect(projectMediaSearchExpanded(7, plain, false)).toBe(true);
  });

  it("keeps a few clips right under the import button in the media panel", () => {
    const html = renderToStaticMarkup(<MediaBin assets={assets(3)} runtimeUrls={{}} onImport={vi.fn()} onAddAssetToTimeline={vi.fn()} />);
    expect((html.match(/class="asset-row"/g) ?? []).length).toBe(3);
    const search = html.indexOf('class="project-media-search"'), list = html.indexOf('data-testid="user-asset-list"');
    expect(search).toBeGreaterThan(html.indexOf("import-drop"));
    expect(list).toBeGreaterThan(search);
    expect(html.slice(search, list)).toContain('data-collapsed="true"');
    expect(html.slice(search, list)).not.toContain("<select");
    // The folded button keeps the .project-media-search class, so mediaBinStates.css still keeps it from shrinking
    // under the next card.
    expect(html).toContain('<section class="project-media-search" data-collapsed="true"');
    const states = readFileSync(new URL("./mediaBinStates.css", import.meta.url), "utf8");
    expect(states).toMatch(/\.media-bin > :is\([^)]*\.project-media-search[^)]*\) \{ flex-shrink: 0; \}/);
  });

  it("has all five languages for the fold button", () => {
    for (const locale of [en, es, ja, ko]) expect(["搜尋素材", "收起搜尋", "搜尋專案素材"].filter(key => !(key in locale))).toEqual([]);
  });
});
