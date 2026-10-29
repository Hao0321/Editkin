import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../../application/projectSession";
import { currentAppProblems, resetAppProblemsForTest } from "../../application/appProblemStore";
import { PROBLEM_WHAT } from "../../application/plainProblems";
import { createUiDemoProject } from "../../domain/demo";
import type { OpenProjectResult } from "../../desktop/mediaTypes";
import { forgetRecentProject, rememberRecentProject, resetRecentProjectsForTest, type RecentProject } from "../../desktop/recentProjects";
import { interfacePreferences, UI_LOCALES } from "../i18n/interfacePreferences";
import { createDemoEasyEngine } from "./easyEngines";
import { createEasyFlowController } from "./easyFlowController";
import { createDemoRecentProjects, type EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore } from "./easyFlowModel";
import { EASY_RECENT_LIMIT, easyRecentItems, easyRecentMessageKeys, recentOpenedWords, type EasyRecentView } from "./easyRecentProjects";
import { EasyScreen, type EasyScreenProps } from "./EasyScreens";
import { createEditorShellEasyHost, type EasyShellProps } from "./useEasyFlowHost";

afterEach(async () => {
  await interfacePreferences.setLocale("zh-TW");
  resetAppProblemsForTest();
});

const at = (month: number, day: number, hour: number, minute: number, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(10, 10, 18, 5);
const project = (name: string, openedAt: number, path = `C:\\Users\\Hao\\Videos\\${name}.editkin.json`): RecentProject => ({ path, name, openedAt });
const NO_STATES = { rows: {}, missing: new Set<string>(), announced: new Set<string>() };

function view(items: EasyRecentView["items"], overrides: Partial<EasyRecentView> = {}): EasyRecentView {
  return { items, busy: false, now: NOW, onOpen: vi.fn(), onForget: vi.fn(), ...overrides };
}
function homeProps(recent?: EasyRecentView): EasyScreenProps {
  const store = createEasyFlowStore();
  const engine = createDemoEasyEngine({ previewUrl: "demo.mp4", wait: () => Promise.resolve() });
  const host: EasyFlowHost = { store, engine, picker: "dialog", chooseVideo: vi.fn(), discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
  return { state: store.getState(), controller: createEasyFlowController(host), formatStatus: engine.formatStatus, videoUrls: {}, canReveal: false, picker: "dialog",
    onChooseVideo: vi.fn(), onFilesChosen: vi.fn(), onSeekPreview: vi.fn(), now: NOW, recent };
}
/** Expands pure function components so their buttons can be pressed without a DOM (as EasyScreens.test does). */
function expand(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => ReactNode)(element.props));
  return [element, ...expand(element.props.children)];
}
const byTestId = (tree: ReactElement<Record<string, any>>[], id: string) => tree.find(element => element.props["data-testid"] === id);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, " ");

describe("when a recent project was last opened, in plain words", () => {
  it("says 今天 14:20, 昨天, N 天前, then the date", () => {
    expect(recentOpenedWords(at(10, 10, 14, 20), NOW, "zh-TW")).toBe("今天 14:20");
    expect(recentOpenedWords(at(10, 9, 23, 50), NOW, "zh-TW")).toBe("昨天");
    expect(recentOpenedWords(at(10, 7, 9, 0), NOW, "zh-TW")).toBe("3 天前");
    expect(recentOpenedWords(at(9, 28, 9, 0), NOW, "zh-TW")).toBe("9月28日");
    expect(recentOpenedWords(at(12, 24, 9, 0, 2025), NOW, "zh-TW")).toBe("2025年12月24日");
    // A clock that moved backwards: a time "in the future" is still today.
    expect(recentOpenedWords(at(10, 10, 20, 0), NOW, "zh-TW")).toBe("今天 20:00");
  });

  it("says it in the interface language", async () => {
    expect(await interfacePreferences.setLocale("en")).toBe(true);
    expect(recentOpenedWords(at(10, 10, 14, 20), NOW, "en")).toBe("Today 14:20");
    expect(recentOpenedWords(at(10, 9, 8, 0), NOW, "en")).toBe("Yesterday");
    expect(recentOpenedWords(at(10, 6, 8, 0), NOW, "en")).toBe("4 days ago");
    expect(recentOpenedWords(at(9, 28, 9, 0), NOW, "en")).toBe("September 28");
  });
});

describe("recent projects on the easy start screen", () => {
  it("shows at most five, and a folder line only where two names are the same", () => {
    const list = [project("旅行", NOW - 1), project("拉麵", NOW - 2), project("旅行", NOW - 3, "D:\\舊硬碟\\作品\\旅行.editkin.json"),
      project("生日", NOW - 4), project("開箱", NOW - 5), project("第六支", NOW - 6), project("第七支", NOW - 7)];
    const items = easyRecentItems(list, NO_STATES);
    expect(items).toHaveLength(EASY_RECENT_LIMIT);
    expect(items.map(item => item.folder)).toEqual(["Hao\\Videos", undefined, "舊硬碟\\作品", undefined, undefined]);
    const failed = easyRecentItems(list, { rows: { [list[1].path]: { state: "failed", problem: { what: PROBLEM_WHAT.damagedProject } } },
      missing: new Set([list[3].path]), announced: new Set([list[1].path]) });
    expect(failed.map(item => item.state)).toEqual(["ready", "failed", "ready", "missing", "ready"]);
    expect(failed[1]).toMatchObject({ problem: { what: PROBLEM_WHAT.damagedProject }, announce: true });
    expect(failed[3].announce).toBeUndefined();
  });

  it("renders big buttons with the name and when it was opened, under the one primary button", () => {
    const items = easyRecentItems([project("我的旅行 vlog", at(10, 10, 14, 20)), project("拉麵開箱", at(10, 9, 12, 0))], NO_STATES);
    const html = renderToStaticMarkup(<EasyScreen {...homeProps(view(items))} />);
    expect(html).toContain('data-testid="easy-recent"');
    expect(text(html)).toContain("最近的作品");
    expect(text(html)).toMatch(/我的旅行 vlog\s+上次打開：今天 14:20/);
    expect(text(html)).toMatch(/拉麵開箱\s+上次打開：昨天/);
    expect(html.match(/data-easy-primary=""/g)).toHaveLength(1);
    expect(html).not.toMatch(/easy-recent-open[^>]*disabled/);
  });

  it("says plainly when a file is gone, offers 從清單移除, and opens with one click", () => {
    const gone = project("鶯歌老街", at(10, 7, 9, 0)), here = project("生日派對", at(9, 28, 9, 0));
    const recent = view(easyRecentItems([here, gone], { ...NO_STATES, missing: new Set([gone.path]) }));
    const tree = expand(<EasyScreen {...homeProps(recent)} />);
    expect(byTestId(tree, "easy-recent-open-1")?.props.disabled).toBe(true);
    expect(text(renderToStaticMarkup(<EasyScreen {...homeProps(recent)} />))).toContain("找不到這個檔案了，可能被移走或刪掉了。");
    byTestId(tree, "easy-recent-forget-1")!.props.onClick();
    expect(recent.onForget).toHaveBeenCalledWith(gone.path);
    byTestId(tree, "easy-recent-open-0")!.props.onClick();
    expect(recent.onOpen).toHaveBeenCalledWith(here.path);
  });

  it("lets one project open at a time and says 正在打開…", () => {
    const list = [project("旅行", NOW - 1), project("拉麵", NOW - 2)];
    const recent = view(easyRecentItems(list, { ...NO_STATES, rows: { [list[0].path]: { state: "opening" } } }), { busy: true });
    const html = renderToStaticMarkup(<EasyScreen {...homeProps(recent)} />);
    expect(text(html)).toContain("正在打開…");
    expect(html.match(/class="easy-recent-open"[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
  });

  it("shows a plain reason with 查看原因 after an open that did not work", () => {
    const list = [project("壞掉的檔案", NOW - 1)];
    const recent = view(easyRecentItems(list, { rows: { [list[0].path]: { state: "failed", problem: { what: PROBLEM_WHAT.damagedProject, detail: "Unexpected token < in JSON" } } },
      missing: new Set(), announced: new Set([list[0].path]) }));
    const html = renderToStaticMarkup(<EasyScreen {...homeProps(recent)} />);
    expect(text(html)).toContain(PROBLEM_WHAT.damagedProject);
    expect(html).toMatch(/role="alert"[^>]*data-testid="easy-recent-failed-0"/);
    expect(html).toContain("查看原因");
  });

  it("has no list without recent projects (the plain browser build has none)", () => {
    expect(renderToStaticMarkup(<EasyScreen {...homeProps()} />)).not.toContain("easy-recent");
    expect(renderToStaticMarkup(<EasyScreen {...homeProps(view([]))} />)).not.toContain("easy-recent");
  });

  it.each(UI_LOCALES.filter(locale => locale !== "zh-TW"))("is fully translated in %s", async locale => {
    expect(await interfacePreferences.setLocale(locale)).toBe(true);
    const before = new Set(interfacePreferences.missingKeys());
    const list = [project("Trip", at(10, 10, 14, 20)), project("Ramen", at(10, 9, 9, 0)), project("Old", at(10, 7, 9, 0))];
    const recent = view(easyRecentItems(list, { rows: { [list[1].path]: { state: "failed", problem: { what: PROBLEM_WHAT.damagedProject, detail: "x" } } },
      missing: new Set([list[2].path]), announced: new Set() }));
    const html = renderToStaticMarkup(<EasyScreen {...homeProps(recent)} />);
    if (locale === "en" || locale === "es") expect(text(html)).not.toMatch(/[\u3400-\u9fff]/);
    for (const key of easyRecentMessageKeys()) expect(interfacePreferences.translate(key), key).not.toBe(key);
    expect(interfacePreferences.missingKeys().filter(key => !before.has(key) && key.startsWith(`${locale}:`))).toEqual([]);
  });
});

describe("the editor shell's recent projects", () => {
  function shell(options: { isDesktop?: boolean; open?: (path: string) => Promise<OpenProjectResult>; exists?: boolean } = {}) {
    const session = createProjectSession(createUiDemoProject());
    const props = {
      projectSession: session, isDesktop: options.isDesktop ?? true, status: "", importFiles: vi.fn(async () => undefined),
      creativeLibrary: { importState: { phase: "idle" } } as unknown as EasyShellProps["creativeLibrary"], runtimeUrls: {}, runCommand: vi.fn(() => true),
      setSelectedClipId: vi.fn(), setSelectedCaptionId: vi.fn(), pausePlayback: vi.fn(), openProject: vi.fn(async () => undefined),
      loadOpenedProject: vi.fn((opened: OpenProjectResult) => { session.replaceProject(opened.project!, opened.path); }), setStatus: vi.fn(),
    } satisfies EasyShellProps;
    const openWorkspace = vi.fn();
    const openProjectPath = vi.fn(options.open ?? (async (path: string) => ({ canceled: false, path, project: createUiDemoProject() }) as OpenProjectResult));
    const checkMediaPaths = vi.fn(async (paths: string[]) => paths.map(() => options.exists ?? true));
    const { host } = createEditorShellEasyHost({ store: createEasyFlowStore(), live: () => ({ props, openWorkspace }), launchRoughCut: vi.fn(),
      settle: () => Promise.resolve(), desktopApi: { openProjectPath, checkMediaPaths } });
    return { host, props, openWorkspace, openProjectPath, checkMediaPaths, session };
  }
  afterEach(() => { resetRecentProjectsForTest(); });

  it("exists only on the desktop with the open-by-path command", () => {
    expect(shell().host.recent).toBeDefined();
    expect(shell({ isDesktop: false }).host.recent).toBeUndefined();
  });

  it("opens a recent project through the editor's own path and shows the editor", async () => {
    const s = shell();
    const path = "C:\\Users\\Hao\\Videos\\旅行.editkin.json";
    await expect(s.host.recent!.open(path)).resolves.toEqual({ kind: "opened" });
    expect(s.openProjectPath).toHaveBeenCalledWith(path);
    expect(s.props.loadOpenedProject).toHaveBeenCalledTimes(1);
    expect(s.openWorkspace).toHaveBeenCalledTimes(1);
    expect(await s.host.recent!.exists!([path])).toEqual([true]);
  });

  it("says a gone file is missing, and other failures in plain words, without leaving a notice behind", async () => {
    const gone = shell({ open: async () => { throw new Error("ENOENT: no such file or directory, open 'C:\\x.editkin.json'"); } });
    await expect(gone.host.recent!.open("C:\\x.editkin.json")).resolves.toEqual({ kind: "missing" });
    expect(currentAppProblems()).toEqual([]);
    expect(gone.openWorkspace).not.toHaveBeenCalled();
    const damaged = shell({ open: async () => { throw new Error("Unexpected token < in JSON at position 0"); } });
    await expect(damaged.host.recent!.open("C:\\y.editkin.json")).resolves.toEqual({ kind: "failed", what: PROBLEM_WHAT.damagedProject,
      detail: "Unexpected token < in JSON at position 0" });
    expect(currentAppProblems()).toEqual([]);
  });

  it("removes a project from the list only (the file is never touched)", () => {
    const s = shell();
    resetRecentProjectsForTest();
    rememberRecentProject("C:\\a.editkin.json", "A", 1);
    rememberRecentProject("C:\\b.editkin.json", "B", 2);
    s.host.recent!.forget("C:\\a.editkin.json");
    expect(s.host.recent!.list().map(item => item.name)).toEqual(["B"]);
    forgetRecentProject("C:\\b.editkin.json");
  });

  it("the dev demo has a simulated list with one gone file", async () => {
    const opened = vi.fn();
    const demo = createDemoRecentProjects(opened, NOW, 0);
    expect(demo.list()).toHaveLength(4);
    expect(await demo.exists!(demo.list().map(item => item.path))).toEqual([true, true, false, true]);
    await expect(demo.open(demo.list()[2].path)).resolves.toEqual({ kind: "missing" });
    await expect(demo.open(demo.list()[0].path)).resolves.toEqual({ kind: "opened" });
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
