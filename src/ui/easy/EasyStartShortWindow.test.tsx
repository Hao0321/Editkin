import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EasyFlow } from "./EasyFlow";
import { createDemoEasyEngine } from "./easyEngines";
import type { EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore } from "./easyFlowModel";

// Hook doubles (as in the Timeline suites) so the effects EasyFlow registers can be run and cleaned up without a DOM.
const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: (factory: () => unknown) => factory(), useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [typeof value === "function" ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); } };
});
vi.mock("../i18n/interfacePreferences", async importOriginal => ({ ...await importOriginal<typeof import("../i18n/interfacePreferences")>(), useI18n: () => ({}) }));
afterEach(() => { hooks.effects.length = 0; vi.unstubAllGlobals(); });

function host(): EasyFlowHost {
  return { store: createEasyFlowStore(), engine: createDemoEasyEngine({ previewUrl: "demo.mp4" }), picker: "dialog",
    chooseVideo: vi.fn(async () => ({ kind: "nothing" as const })), discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
}

describe("leaving the start screens", () => {
  it("opens the editor at the top of the window, not where a short window had the start page scrolled to", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("window", { scrollTo });
    EasyFlow({ host: host() });
    const cleanups = hooks.effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    expect(scrollTo).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });
});

describe("the start screen on a short window", () => {
  const css = postcss.parse(readFileSync(new URL("./easyFlow.css", import.meta.url), "utf8"));
  const rule = (selector: string, media: string) => {
    let found: Rule | undefined;
    css.walkRules(item => {
      const parent = item.parent?.type === "atrule" ? (item.parent as unknown as { params: string }).params : undefined;
      if (parent === media && item.selectors.includes(selector)) found = item;
    });
    if (!found) throw new Error(`missing ${selector} in ${media}`);
    const declarations: Record<string, string> = {};
    found.walkDecls(decl => { declarations[decl.prop] = decl.value.replace(/\s+/g, " "); });
    return declarations;
  };

  // Measured in headless Chrome at 1280×720 with four recent projects (.rd/benchmarks/usable-v1-20261009/work/
  // layout-1280-20261010): 「選擇影片」 at y 347–409, the first two recent projects end at y 607 and 696, in zh-TW and
  // English. Before: the list started at y 708, below the window.
  it("lays the format cards flat when recent projects are listed, so the first two are in view at 1280×720", () => {
    expect(rule(".easy-home:has(.easy-recent) .easy-format", "(max-height: 820px)")).toMatchObject({
      "grid-template-columns": "calc(104px * var(--easy-scale)) minmax(0, 1fr)", "text-align": "start" });
    expect(rule(".easy-home:has(.easy-recent) .easy-frame-vertical", "(max-height: 820px)")).toMatchObject({ height: "calc(76px * var(--easy-scale))" });
    expect(rule(".easy-home:has(.easy-recent)", "(max-height: 820px)")).toMatchObject({ gap: "calc(16px * var(--easy-scale))" });
  });

  it("does the same on the 800×560 minimum window with or without recent projects, so 「選擇影片」 is never below the fold", () => {
    expect(rule(".easy-home .easy-format", "(max-height: 640px)")).toMatchObject({ "grid-template-columns": "calc(104px * var(--easy-scale)) minmax(0, 1fr)" });
  });

  it("keeps 「選擇影片」 the one big filled button: the flat cards stay outlined", () => {
    const primary: Record<string, string> = {};
    css.walkRules(item => { if (item.selector === ".easy-primary") item.walkDecls(decl => { primary[decl.prop] = decl.value; }); });
    expect(primary).toMatchObject({ background: "var(--accent)" });
    for (const media of ["(max-height: 820px)", "(max-height: 640px)"]) {
      css.walkAtRules("media", at => {
        if (at.params !== media) return;
        at.walkDecls(decl => { expect(decl.prop === "background" && decl.value.includes("--accent")).toBe(false); });
      });
    }
  });
});
