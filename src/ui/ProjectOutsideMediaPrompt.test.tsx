import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import { createProjectOutsideMediaPrompt, shortFolder, type ProjectOutsideMediaApi, type ProjectOutsideMediaPromptState } from "../desktop/projectOutsideMediaConsent";
import type { ProjectOutsideMediaInspection } from "../desktop/apiTypes";
import { OUTSIDE_MEDIA_GRANT_HINT, outsideMediaRefusalMessage } from "../mcp/outsideMediaGrants";
// The real translations; only the hook that subscribes to them is a plain call, so the component can be called directly.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { ProjectOutsideMediaPrompt, ProjectOutsideMediaPromptView, PROJECT_OUTSIDE_MEDIA_LISTED } from "./ProjectOutsideMediaPrompt";
import en from "./i18n/locales/en";
import es from "./i18n/locales/es";
import ja from "./i18n/locales/ja";
import ko from "./i18n/locales/ko";

const BS = "\\";
const QUESTION = "這個專案用到工作區外的 {count} 個素材。要允許 AI 助手讀取它們嗎？（只有你在這台電腦上按允許才會生效）";
const PROJECT = ["D:", "Trips", "kyoto.editkin.json"].join(BS);
const OTHER = ["D:", "Trips", "osaka.editkin.json"].join(BS);
const FILES = [
  { path: ["E:", "Camera Roll", "2026", "IMG_0001.MOV"].join(BS), name: "IMG_0001.MOV" },
  { path: ["C:", "Users", "hao", "Music", "song.flac"].join(BS), name: "song.flac" },
];

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find(element => element.props["data-testid"] === id);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(answer: (path: string) => ProjectOutsideMediaInspection = () => ({ count: FILES.length, items: FILES })) {
  const session = createProjectSession(createDemoProject(), PROJECT);
  const api = {
    inspectProjectOutsideMedia: vi.fn(async (path: string) => answer(path)),
    grantProjectOutsideMedia: vi.fn(async (_path: string, paths: string[]) => ({ granted: paths.length })),
  } satisfies ProjectOutsideMediaApi;
  const declined = new Set<string>();
  const prompt = createProjectOutsideMediaPrompt({ session, api, declined });
  const open = (path: string) => session.replaceProject(createDemoProject(), path);
  return { session, api, declined, prompt, open };
}
const asking = (state: ProjectOutsideMediaPromptState) => {
  if (state.kind !== "asking") throw new Error(`expected the question, got ${state.kind}`);
  return state;
};

describe("outside-media consent prompt: when it asks", () => {
  it("asks when the host reports media that are not granted yet (count above 0), and only then", async () => {
    const f = fixture();
    const stop = f.prompt.start();
    expect(f.api.inspectProjectOutsideMedia).toHaveBeenCalledWith(PROJECT);
    await flush();
    const state = asking(f.prompt.getSnapshot());
    expect(state).toMatchObject({ projectPath: PROJECT, count: 2, busy: false, failed: false });
    expect(state.files).toEqual(FILES);
    expect(f.api.grantProjectOutsideMedia).not.toHaveBeenCalled();
    stop();

    const none = fixture(() => ({ count: 0, items: [] }));
    none.prompt.start();
    await flush();
    expect(none.prompt.getSnapshot()).toEqual({ kind: "hidden" });
  });

  it("checks each opened project once; editing does not ask again, opening another project does", async () => {
    const f = fixture();
    f.prompt.start();
    await flush();
    f.session.setHistory(history => ({ ...history }));
    expect(f.api.inspectProjectOutsideMedia).toHaveBeenCalledTimes(1);
    f.open(OTHER);
    expect(f.prompt.getSnapshot()).toEqual({ kind: "hidden" });
    await flush();
    expect(f.api.inspectProjectOutsideMedia).toHaveBeenLastCalledWith(OTHER);
    expect(asking(f.prompt.getSnapshot()).projectPath).toBe(OTHER);
  });

  it("checks a project opened from a batch run the same way (App.tsx loadOpenedProject replaces the session with its saved path)", async () => {
    const batchProject = ["E:", "Batch output", "IMG_0420.editkin.json"].join(BS);
    const f = fixture();
    f.prompt.start();
    await flush();
    f.prompt.decline();
    // useBatchAutoEdit → onOpenProject(opened) → projectSession.replaceProject(opened.project, opened.path, …)
    f.session.replaceProject(createDemoProject(), batchProject, {});
    await flush();
    expect(f.api.inspectProjectOutsideMedia).toHaveBeenLastCalledWith(batchProject);
    expect(asking(f.prompt.getSnapshot()).projectPath).toBe(batchProject);
  });

  it("asks nothing for an unsaved project, when the host cannot answer, or for an answer that arrives after another project opened", async () => {
    const unsaved = fixture();
    unsaved.session.replaceProject(createDemoProject());
    unsaved.prompt.start();
    expect(unsaved.api.inspectProjectOutsideMedia).not.toHaveBeenCalled();

    const failing = fixture();
    failing.api.inspectProjectOutsideMedia.mockRejectedValueOnce(new Error("read_project failed"));
    failing.prompt.start();
    await flush();
    expect(failing.prompt.getSnapshot()).toEqual({ kind: "hidden" });

    let release: (value: ProjectOutsideMediaInspection) => void = () => undefined;
    const slow = fixture();
    slow.api.inspectProjectOutsideMedia.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    slow.api.inspectProjectOutsideMedia.mockImplementation(async () => ({ count: 0, items: [] }));
    slow.prompt.start();
    slow.open(OTHER);
    release({ count: 2, items: FILES });
    await flush();
    expect(slow.prompt.getSnapshot()).toEqual({ kind: "hidden" });
  });
});

describe("outside-media consent prompt: 允許 and 先不要", () => {
  it("允許 sends the project path and exactly the listed files to the host command, then hides", async () => {
    const f = fixture();
    f.prompt.start();
    await flush();
    const allowing = f.prompt.allow();
    expect(asking(f.prompt.getSnapshot()).busy).toBe(true);
    await allowing;
    expect(f.api.grantProjectOutsideMedia).toHaveBeenCalledTimes(1);
    expect(f.api.grantProjectOutsideMedia).toHaveBeenCalledWith(PROJECT, FILES.map(file => file.path));
    expect(f.prompt.getSnapshot()).toEqual({ kind: "hidden" });
  });

  it("a failed 允許 keeps the question with a retry note", async () => {
    const f = fixture();
    f.api.grantProjectOutsideMedia.mockRejectedValueOnce(new Error("disk full"));
    f.prompt.start();
    await flush();
    await f.prompt.allow();
    expect(asking(f.prompt.getSnapshot())).toMatchObject({ busy: false, failed: true });
    await f.prompt.allow();
    expect(f.api.grantProjectOutsideMedia).toHaveBeenCalledTimes(2);
    expect(f.prompt.getSnapshot()).toEqual({ kind: "hidden" });
  });

  it("先不要 hides it and the same project is not asked about again in this session; another project still is", async () => {
    const f = fixture();
    f.prompt.start();
    await flush();
    f.prompt.decline();
    expect(f.prompt.getSnapshot()).toEqual({ kind: "hidden" });
    expect(f.api.grantProjectOutsideMedia).not.toHaveBeenCalled();
    expect([...f.declined]).toEqual([PROJECT]);
    f.open(PROJECT); // reopened (a new session of the same file)
    await flush();
    expect(f.api.inspectProjectOutsideMedia).toHaveBeenCalledTimes(1);
    expect(f.prompt.getSnapshot()).toEqual({ kind: "hidden" });
    f.open(OTHER);
    await flush();
    expect(asking(f.prompt.getSnapshot()).projectPath).toBe(OTHER);
  });

  it("先不要 is remembered in memory only: a new run of Editkin (a fresh memory) asks again", async () => {
    const first = fixture();
    first.prompt.start();
    await flush();
    first.prompt.decline();
    const nextRun = fixture();
    nextRun.prompt.start();
    await flush();
    expect(asking(nextRun.prompt.getSnapshot()).projectPath).toBe(PROJECT);
  });
});

describe("outside-media consent prompt: what the creator sees", () => {
  const state = { kind: "asking" as const, projectPath: PROJECT, count: 2, files: FILES, busy: false, failed: false };

  it("is a plain status card with the zh-TW question, 允許 / 先不要 and file names only (folder shortened), not a dialog", () => {
    const html = renderToStaticMarkup(<ProjectOutsideMediaPromptView state={state} onAllow={vi.fn()} onDecline={vi.fn()} />);
    expect(html).toContain("這個專案用到工作區外的 2 個素材。要允許 AI 助手讀取它們嗎？（只有你在這台電腦上按允許才會生效）");
    expect(html).toContain(">允許</button>");
    expect(html).toContain(">先不要</button>");
    expect(html).toContain("<details");
    expect(html).toContain("看是哪些檔案");
    expect(html).toContain("<b title=\"IMG_0001.MOV\">IMG_0001.MOV</b><small>…" + BS + "2026</small>");
    expect(html).toContain("<b title=\"song.flac\">song.flac</b><small>…" + BS + "Music</small>");
    expect(html).not.toContain("Camera Roll");
    expect(html).not.toContain(FILES[1].path);
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/role="(alert)?dialog"|aria-modal/);
  });

  it("its buttons call 允許 and 先不要, and are disabled while 允許 is being recorded", () => {
    const onAllow = vi.fn(), onDecline = vi.fn();
    const tree = ProjectOutsideMediaPromptView({ state, onAllow, onDecline });
    (byTestId(tree, "project-outside-media-allow")!.props.onClick as () => void)();
    (byTestId(tree, "project-outside-media-decline")!.props.onClick as () => void)();
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
    const busy = renderToStaticMarkup(<ProjectOutsideMediaPromptView state={{ ...state, busy: true }} onAllow={vi.fn()} onDecline={vi.fn()} />);
    const buttonTag = (testId: string) => busy.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
    expect(buttonTag("project-outside-media-allow")).toContain('disabled=""');
    expect(buttonTag("project-outside-media-decline")).toContain('disabled=""');
    expect(busy).toContain(">處理中…</button>");
    const failed = renderToStaticMarkup(<ProjectOutsideMediaPromptView state={{ ...state, failed: true }} onAllow={vi.fn()} onDecline={vi.fn()} />);
    expect(failed).toContain("沒有記錄到你的允許，請再按一次。");
  });

  it("lists a bounded number of names and counts the rest", () => {
    const many = Array.from({ length: PROJECT_OUTSIDE_MEDIA_LISTED + 3 }, (_, index) => ({ path: `E:${BS}clips${BS}c${index}.mp4`, name: `c${index}.mp4` }));
    const html = renderToStaticMarkup(<ProjectOutsideMediaPromptView state={{ ...state, count: many.length, files: many }} onAllow={vi.fn()} onDecline={vi.fn()} />);
    expect(html.match(/<li>/g)).toHaveLength(PROJECT_OUTSIDE_MEDIA_LISTED);
    expect(html).toContain("還有 3 個");
  });

  it("shows nothing in the browser build, on the start screen or before anything needs asking", () => {
    const session = createProjectSession(createDemoProject(), PROJECT);
    const api = { inspectProjectOutsideMedia: vi.fn(), grantProjectOutsideMedia: vi.fn() };
    expect(renderToStaticMarkup(<ProjectOutsideMediaPrompt session={session} api={{}} />)).toBe("");
    expect(renderToStaticMarkup(<ProjectOutsideMediaPrompt session={session} api={api} enabled={false} />)).toBe("");
    expect(renderToStaticMarkup(<ProjectOutsideMediaPrompt session={session} api={api} />)).toBe("");
    expect(api.inspectProjectOutsideMedia).not.toHaveBeenCalled(); // asked from an effect, never while rendering
  });

  it("shortens folders to their last part, or the root", () => {
    expect(shortFolder(FILES[0].path)).toBe(`…${BS}2026`);
    expect(shortFolder(`C:${BS}clip.mov`)).toBe(`C:${BS}`);
    expect(shortFolder("/media/clip.mov")).toBe("/media/");
    expect(shortFolder("/Users/hao/Movies/clip.mov")).toBe("…/Movies");
    expect(shortFolder("clip.mov")).toBe("");
  });

  it("has every prompt string in all five languages", () => {
    for (const key of [QUESTION, "允許", "先不要", "看是哪些檔案", "還有 {count} 個", "處理中…", "沒有記錄到你的允許，請再按一次。"]) {
      for (const [locale, messages] of Object.entries({ en, es, ja, ko })) {
        expect(messages[key], `${locale}: ${key}`).toBeTruthy();
        expect(messages[key], `${locale}: ${key}`).not.toBe(key);
      }
    }
    expect(en[QUESTION]).toContain("{count}");
    expect(en["允許"]).toBe("Allow");
  });
});

describe("the MCP refusal points at this prompt", () => {
  it("says to open the project in Editkin and choose 允許, or set EDITKIN_EXTRA_MEDIA_ROOTS", () => {
    expect(OUTSIDE_MEDIA_GRANT_HINT).toContain("開啟這個專案");
    expect(OUTSIDE_MEDIA_GRANT_HINT).toContain("「要允許 AI 助手讀取它們嗎？」的提示選「允許」");
    expect(OUTSIDE_MEDIA_GRANT_HINT).toContain("EDITKIN_EXTRA_MEDIA_ROOTS");
    expect(outsideMediaRefusalMessage("asset-1", "not_granted").endsWith(OUTSIDE_MEDIA_GRANT_HINT)).toBe(true);
  });
});
