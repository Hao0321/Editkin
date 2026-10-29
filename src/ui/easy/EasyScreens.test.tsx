import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interfacePreferences, UI_LOCALES } from "../i18n/interfacePreferences";
import { createDemoEasyEngine, createRoughCutEasyEngine, createUnavailableEasyEngine, ROUGH_CUT_STEPS, TEMPLATE_STEPS } from "./easyEngines";
import { createEasyFlowController } from "./easyFlowController";
import type { EasyFlowHost } from "./easyFlowHost";
import {
  createEasyFlowStore, easyFlowReducer, initialEasyFlowState, type EasyAutoEditEngine, type EasyEnginePlan, type EasyFlowAction,
  type EasyFlowState, type EasyScreen as EasyScreenName, type EasyVideo,
} from "./easyFlowModel";
import { EasyScreen, type EasyScreenProps } from "./EasyScreens";
import { TEMPLATE_SHORT_STEPS } from "./templateShortEngine";

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); });

const portrait: EasyVideo = { id: "asset-v", name: "IMG_4022.MOV", orientation: "portrait", durationSeconds: 42 };
const landscape: EasyVideo = { id: "asset-h", name: "IMG_3310.MOV", orientation: "landscape", durationSeconds: 95 };
const templatePlan: EasyEnginePlan = { needsTitle: true, steps: TEMPLATE_STEPS, estimateSeconds: 60, canRestyle: true, canEditText: true, rendersPreview: true, canCancel: true };
const roughPlan: EasyEnginePlan = { needsTitle: false, steps: ROUGH_CUT_STEPS, canRestyle: false, canEditText: false, rendersPreview: false, canCancel: false };
const shortsPlan: EasyEnginePlan = { needsTitle: true, copy: "story", steps: TEMPLATE_SHORT_STEPS, canRestyle: false, canEditText: true, rendersPreview: true, canCancel: true };
const instantDemo = () => createDemoEasyEngine({ previewUrl: "demo.mp4", wait: () => Promise.resolve() });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const JARGON = ["粗剪", "軌道", "fps", "Autosave", "匯出專案", "時間軸"];

function harness(engine: EasyAutoEditEngine = instantDemo(), picker: EasyFlowHost["picker"] = "dialog", video = portrait) {
  const store = createEasyFlowStore();
  const host: EasyFlowHost = {
    store, engine, picker, chooseVideo: vi.fn(async () => ({ kind: "video" as const, video })),
    discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn(),
  };
  const controller = createEasyFlowController(host, () => 1_000);
  const onSeekPreview = vi.fn();
  const props = (overrides: Partial<EasyScreenProps> = {}): EasyScreenProps => ({
    state: store.getState(), controller, formatStatus: engine.formatStatus, videoUrls: {}, canReveal: controller.canReveal(), picker,
    onChooseVideo: () => { if (controller.canChooseVideo()) void controller.chooseVideo(); }, onFilesChosen: files => void controller.chooseVideo(files),
    onSeekPreview, now: 6_000, ...overrides,
  });
  const html = (overrides?: Partial<EasyScreenProps>) => renderToStaticMarkup(<EasyScreen {...props(overrides)} />);
  const tree = (overrides?: Partial<EasyScreenProps>) => expand(<EasyScreen {...props(overrides)} />);
  return { store, host, controller, props, html, tree, onSeekPreview };
}

/** Expands pure function components so their buttons can be pressed without a DOM. */
function expand(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => ReactNode)(element.props));
  return [element, ...expand(element.props.children)];
}
const byTestId = (tree: ReactElement<Record<string, any>>[], id: string) => {
  const found = tree.filter(element => element.props["data-testid"] === id);
  expect(found, id).toHaveLength(1);
  return found[0];
};
const primaryCount = (html: string) => (html.match(/data-easy-primary=""/g) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ");
const reduce = (state: EasyFlowState, ...actions: EasyFlowAction[]) => actions.reduce(easyFlowReducer, state);

/** One state per screen, built with the real reducer. */
function screenStates(plan: EasyEnginePlan, video: EasyVideo): Omit<Record<EasyScreenName, EasyFlowState>, "rights" | "hook" | "points"> {
  const home = initialEasyFlowState();
  const genre = reduce(home, { type: "choose-format", format: video.orientation === "portrait" ? "vertical" : "horizontal" }, { type: "pick-started" },
    { type: "pick-finished", video, check: { ok: true, plan } });
  const title = reduce(genre, { type: "show-title" }, { type: "set-title", value: "Waterfall" });
  const working = reduce(plan.needsTitle ? title : genre, { type: "run-started", runId: 1, startedAt: 1_000, estimateSeconds: plan.estimateSeconds },
    { type: "run-progress", runId: 1, step: 1, fraction: 0.5 });
  const result = reduce(working, { type: "run-finished", runId: 1, result: plan.rendersPreview
    ? { orientation: "vertical", previewUrl: "demo.mp4", flags: [{ second: 3, kind: "text-cut" }] }
    : { orientation: "horizontal", flags: [], summary: { segments: 9, captions: 27, music: true } } });
  const saving = reduce(result, { type: "save-started" });
  const saved = reduce(saving, { type: "save-finished", saved: plan.rendersPreview ? { fileName: "Waterfall.mp4", inVideosFolder: true }
    : { path: "D:\\Videos\\IMG_3310.mp4", fileName: "IMG_3310.mp4", folderName: "Videos" } });
  const failed = reduce(working, { type: "run-failed", runId: 1, problem: { kind: "engine-failed", detail: "decoder stopped" } });
  const unavailable = reduce(home, { type: "choose-format", format: "vertical" }, { type: "pick-started" },
    { type: "pick-finished", video, check: { ok: false, reason: "shorts-connecting" } });
  return { home, genre, title, working, result, saving, saved, failed, unavailable };
}

/** Every screen of a template Short (story copy), built with the real reducer. Creator text is ASCII so the en/es
 * check below can tell interface words from the creator's own. */
function storyStates(video: EasyVideo = portrait): Record<EasyScreenName, EasyFlowState> {
  const home = reduce(initialEasyFlowState(), { type: "choose-format", format: "vertical" });
  const rights = reduce(home, { type: "pick-started" }, { type: "pick-finished", video, check: { ok: true, plan: shortsPlan },
    rights: { kind: "ask", scope: { name: "videos", kind: "folder" } } });
  const genre = reduce(rights, { type: "rights-confirmed" });
  const hook = reduce(genre, { type: "show-hook" }, { type: "set-hook", value: "Bats" });
  const title = reduce(hook, { type: "hook-done", skipped: false }, { type: "set-title", value: "Waterfall" });
  const points = reduce(genre, { type: "show-hook" }, { type: "hook-done", skipped: true }, { type: "set-title", value: "Waterfall" }, { type: "show-points" },
    { type: "set-point", index: 0, value: "Drips" }, { type: "set-point", index: 1, value: "Path" });
  const working = reduce(title, { type: "run-started", runId: 1, startedAt: 1_000 }, { type: "run-progress", runId: 1, step: 2, fraction: 0.5 });
  const result = reduce(working, { type: "run-finished", runId: 1, result: { orientation: "vertical", previewUrl: "short.mp4", handle: "job-1",
    flags: [{ second: 3, kind: "stutter" }], usedRange: { seconds: 15, clamped: true }, review: true } });
  const saving = reduce(result, { type: "save-started" });
  const saved = reduce(saving, { type: "save-finished", saved: { path: "C:\\Users\\a\\Videos\\Waterfall.mp4", fileName: "Waterfall.mp4", folderName: "Videos", inVideosFolder: true } });
  const failed = reduce(working, { type: "run-failed", runId: 1, problem: { kind: "words", detail: "Q3_safe_area" } });
  const unavailable = reduce(home, { type: "pick-started" }, { type: "pick-finished", video, check: { ok: true, plan: shortsPlan },
    rights: { kind: "unavailable", reason: "outside-workspace" } });
  return { home, rights, genre, hook, title, points, working, result, saving, saved, failed, unavailable };
}

describe("1 首頁「放影片進來，我幫你剪好」", () => {
  it("shows two big kinds of video, one primary 選擇影片 and the two small ways out", () => {
    const { html } = harness();
    const markup = html();
    expect(markup).toContain("放影片進來，我幫你剪好");
    expect(markup).toContain("直的短影音");
    expect(markup).toContain("橫的影片");
    expect(markup).toContain("YouTube");
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-choose-video"/);
    expect(markup).toContain("我想自己剪");
    expect(markup).toContain("打開之前的作品");
  });

  it("asks for a kind of video in place instead of opening the chooser", () => {
    const { tree, html, host } = harness();
    byTestId(tree(), "easy-choose-video").props.onClick();
    expect(host.chooseVideo).not.toHaveBeenCalled();
    expect(html()).toMatch(/role="alert"[^>]*data-testid="easy-format-hint"/);
    expect(html()).toContain("先點一下你要做哪一種影片");
  });

  it("brings the video in after a kind is chosen and moves to the next question", async () => {
    const { tree, store, host } = harness();
    const vertical = tree().find(element => element.type === "input" && element.props.value === "vertical")!;
    vertical.props.onChange();
    expect(store.getState().format).toBe("vertical");
    byTestId(tree(), "easy-choose-video").props.onClick();
    expect(store.getState().picking).toBe(true);
    await flush();
    expect(host.chooseVideo).toHaveBeenCalledTimes(1);
    expect(store.getState().screen).toBe("genre");
  });

  it("says plainly while the video is coming in", () => {
    const { store, html } = harness();
    store.dispatch({ type: "choose-format", format: "vertical" });
    store.dispatch({ type: "pick-started" });
    const markup = html();
    expect(markup).toContain("正在放進來…");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-easy-primary=""|<button[^>]*data-easy-primary=""[^>]*disabled=""/);
  });

  it("marks kinds that cannot be edited automatically yet, before anything is chosen", () => {
    const { html, store } = harness(createRoughCutEasyEngine({ start: vi.fn(), render: vi.fn() }));
    expect(html()).toContain("自動剪輯還在接上");
    store.dispatch({ type: "choose-format", format: "vertical" });
    expect(html()).toContain("直的短影音的自動剪輯還在接上。選了影片之後，可以先在剪輯台自己剪。");
    const browser = harness(createUnavailableEasyEngine("needs-desktop"));
    expect(browser.html().match(/要用桌面版/g)).toHaveLength(2);
  });

  it("uses a hidden video-only file input in a browser", () => {
    const { html } = harness(instantDemo(), "file-input");
    expect(html()).toMatch(/<input[^>]*type="file"[^>]*accept="video\/\*"/);
    expect(harness().html()).not.toContain('type="file"');
  });

  it("keeps the existing editor and earlier work one click away", () => {
    const { tree, host } = harness();
    byTestId(tree(), "easy-edit-myself").props.onClick();
    byTestId(tree(), "easy-open-project").props.onClick();
    expect(host.openWorkspace).toHaveBeenCalledTimes(1);
    expect(host.openProject).toHaveBeenCalledTimes(1);
  });

  it("explains a video that could not come in, with the reason one step away", () => {
    const { store, html } = harness();
    store.dispatch({ type: "choose-format", format: "vertical" });
    store.dispatch({ type: "pick-started" });
    store.dispatch({ type: "pick-ended", problem: { kind: "import-failed", detail: "codec" } });
    const markup = html();
    expect(markup).toContain("這支影片沒有放進來。可以再選一次，或換一支影片。");
    expect(markup).toContain("查看原因");
    expect(markup).toContain("codec");
  });
});

describe("2「這支影片在拍什麼？」", () => {
  it("offers six genres plus 讓電腦幫我選 (chosen by default) and one primary 下一步", () => {
    const { store, html } = harness();
    store.dispatch({ type: "choose-format", format: "vertical" });
    store.dispatch({ type: "pick-started" });
    store.dispatch({ type: "pick-finished", video: portrait, check: { ok: true, plan: templatePlan } });
    const markup = html();
    for (const label of ["旅遊", "美食", "教學", "開箱", "遊戲", "生活", "不確定？讓電腦幫我選"]) expect(markup).toContain(label);
    expect(markup.match(/type="radio"/g)).toHaveLength(7);
    expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="auto"/);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toContain("下一步");
    expect(markup).toContain("第 2 步，共 3 步");
    expect(markup).toContain("IMG_4022.MOV");
    expect(markup).toContain("0:42");
  });

  it("starts right here for the rough cut and says what it will and will not do", () => {
    const { store, html } = harness();
    store.dispatch({ type: "choose-format", format: "horizontal" });
    store.dispatch({ type: "pick-started" });
    store.dispatch({ type: "pick-finished", video: landscape, check: { ok: true, plan: roughPlan } });
    const markup = html();
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-start"/);
    expect(markup).toContain("這一版會剪掉停頓的地方、加上字幕和音樂；不會在畫面上加標題。");
    expect(markup).toContain("第 2 步，共 2 步");
  });

  it("goes to the title question after choosing, and back to the start puts the video away", async () => {
    const { store, controller, tree, host } = harness();
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    tree().find(element => element.type === "input" && element.props.value === "food")!.props.onChange();
    expect(store.getState().genre).toBe("food");
    byTestId(tree(), "easy-genre-next").props.onClick();
    expect(store.getState().screen).toBe("title");
    byTestId(tree(), "easy-back").props.onClick();
    byTestId(tree(), "easy-back").props.onClick();
    expect(host.discardVideo).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ screen: "home", format: "vertical" });
  });
});

describe("3「畫面上要寫什麼？」", () => {
  async function atTitle() {
    const h = harness();
    h.controller.chooseFormat("vertical");
    await h.controller.chooseVideo();
    h.controller.confirmGenre();
    return h;
  }

  it("asks for a required big title, an optional note and shows the honesty reminder", async () => {
    const { html } = await atTitle();
    const markup = html();
    expect(markup).toContain("畫面上要寫什麼？");
    expect(markup).toContain("大標題（一定要寫）");
    expect(markup).toContain("一句說明（可以不寫）");
    expect(markup).toContain("店名、價格、數字請照實寫，電腦不會自己亂加。");
    expect(markup).toContain("還可以打 32 個字");
    expect(markup).toMatch(/aria-required="true"/);
    expect(markup).not.toContain("先寫一句大標題");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/type="submit"[^>]*data-easy-primary=""[^>]*data-testid="easy-start"/);
  });

  it("stays here with 先寫一句大標題 when the title is empty, and starts once it is written", async () => {
    const { tree, html, store, host } = await atTitle();
    const start = vi.spyOn(host.engine, "start");
    const submit = () => tree().find(element => element.type === "form")!.props.onSubmit({ preventDefault: () => undefined });
    submit();
    const invalid = html();
    expect(invalid).toMatch(/role="alert"[^>]*data-testid="easy-title-error"/);
    expect(invalid).toContain("先寫一句大標題");
    expect(invalid).toMatch(/aria-invalid="true"/);
    expect(start).not.toHaveBeenCalled();
    byTestId(tree(), "easy-title-input").props.onChange({ currentTarget: { value: "其實是來看水簾的" } });
    expect(html()).not.toContain("先寫一句大標題");
    expect(html()).toContain("還可以打 24 個字");
    byTestId(tree(), "easy-description-input").props.onChange({ currentTarget: { value: "名字叫蝙蝠洞" } });
    submit();
    expect(store.getState().screen).toBe("working");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ title: "其實是來看水簾的", description: "名字叫蝙蝠洞", genre: "auto" }), expect.any(Function), expect.anything());
  });
});

describe("4「正在幫你剪…」", () => {
  it("shows four plain steps, a progress bar and the time left, with no primary button", () => {
    const states = screenStates(templatePlan, portrait);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.working })} />);
    expect(markup).toContain("正在幫你剪…");
    for (const label of TEMPLATE_STEPS) expect(markup).toContain(label);
    expect(markup.match(/data-status="done"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(markup).toMatch(/<li data-status="current"/);
    expect(markup).toMatch(/role="progressbar"[^>]*aria-valuenow="38"/);
    expect(markup).toContain("大約還要 55 秒");
    expect(primaryCount(markup)).toBe(0);
    expect(markup).toContain("停下來");
  });

  it("shows elapsed time instead of a made-up estimate for the rough cut, and no stop button", () => {
    const states = screenStates(roughPlan, landscape);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.working, now: 66_000 })} />);
    for (const label of ROUGH_CUT_STEPS) expect(markup).toContain(label);
    expect(markup).toContain("已經過了 1:05");
    expect(markup).toContain("影片越長，要等越久。");
    expect(markup).not.toContain("大約還要");
    expect(markup).not.toContain("停下來");
    expect(primaryCount(markup)).toBe(0);
  });
});

describe("5「剪好了，你看看」", () => {
  it("plays the finished video with one primary 好了，存成影片 and the two choices", () => {
    const states = screenStates(templatePlan, portrait);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.result })} />);
    expect(markup).toContain("剪好了，你看看");
    expect(markup).toMatch(/<video[^>]*src="demo.mp4"[^>]*controls=""/);
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-save"/);
    expect(markup).toContain("改文字");
    expect(markup).toContain("換一種風格");
    expect(markup).toContain("我想自己細調（進入剪輯台）");
  });

  it("shows 需要修改 with the exact second and a button that jumps there", () => {
    const h = harness();
    const states = screenStates(templatePlan, portrait);
    const markup = renderToStaticMarkup(<EasyScreen {...h.props({ state: states.result })} />);
    expect(markup).toContain("需要修改");
    expect(markup).toContain("第 3 秒");
    expect(markup).toContain("標題有一點被切到");
    expect(markup).toContain("影片還是可以先存，之後再改。");
    byTestId(expand(<EasyScreen {...h.props({ state: states.result })} />), "easy-flag-seek").props.onClick();
    expect(h.onSeekPreview).toHaveBeenCalledWith(3);
    const clean = reduce(states.working, { type: "run-finished", runId: 1, result: { orientation: "vertical", previewUrl: "demo.mp4", flags: [] } });
    expect(renderToStaticMarkup(<EasyScreen {...h.props({ state: clean })} />)).not.toContain("需要修改");
  });

  it("tells the truth about the rough cut: no fake player, what was done, subtitles to double-check", () => {
    const states = screenStates(roughPlan, landscape);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.result })} />);
    expect(markup).not.toContain("<video");
    expect(markup).toContain("剪成 9 段");
    expect(markup).toContain("加上 27 句字幕");
    expect(markup).toContain("配上音樂");
    expect(markup).toContain("字幕是電腦聽寫的，數字和店名請再看一次。");
    expect(markup).not.toContain("改文字");
    expect(markup).not.toContain("換一種風格");
    expect(primaryCount(markup)).toBe(1);
  });

  it("saves, and 我想自己細調 opens the editor", async () => {
    const h = harness();
    h.controller.chooseFormat("vertical");
    await h.controller.chooseVideo();
    h.controller.confirmGenre();
    h.controller.setTitle("標題");
    h.controller.submitTitle();
    await flush();
    expect(h.store.getState().screen).toBe("result");
    byTestId(h.tree(), "easy-fine-tune").props.onClick();
    expect(h.host.leaveToEditor).toHaveBeenCalledTimes(1);
    byTestId(h.tree(), "easy-save").props.onClick();
    expect(h.store.getState().screen).toBe("saving");
    expect(primaryCount(h.html())).toBe(0);
    await flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
    expect(h.store.getState().screen).toBe("saved");
  });
});

describe("6「影片存好了」", () => {
  it("opens the folder as the primary action when the engine can, with 再做一支 beside it", () => {
    const states = screenStates(templatePlan, portrait);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.saved, canReveal: true })} />);
    expect(markup).toContain("影片存好了");
    expect(markup).toContain("放在「影片」資料夾");
    expect(markup).toContain("檔名：Waterfall.mp4");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-reveal"/);
    expect(markup).toContain("再做一支");
  });

  it("shows where the file is when the folder cannot be opened, and 再做一支 becomes the primary action", () => {
    const states = screenStates(roughPlan, landscape);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.saved, canReveal: false })} />);
    expect(markup).toContain("放在「Videos」資料夾");
    expect(markup).toContain("位置：D:\\Videos\\IMG_3310.mp4");
    expect(markup).not.toContain("打開資料夾");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-again"/);
  });
});

describe("直的短影音 (template Shorts)", () => {
  const markupOf = (state: EasyFlowState, extra: Partial<EasyScreenProps> = {}) => renderToStaticMarkup(<EasyScreen {...harness().props({ state, ...extra })} />);

  it("asks 「這些影片是你自己拍的嗎？」 once, naming the folder, with the brand name empty and one explicit yes", () => {
    const markup = markupOf(storyStates().rights);
    expect(markup).toContain("這些影片是你自己拍的嗎？");
    expect(markup).toContain("只有你自己拍的影片，才能自動做成直的短影音。");
    expect(markup).toContain("選「是」，就表示「videos」資料夾裡的影片都是你自己拍的。以後不會再問。");
    expect(markup).toMatch(/<input[^>]*value=""[^>]*data-testid="easy-brand-input"|<input[^>]*data-testid="easy-brand-input"[^>]*value=""/);
    expect(markup).not.toMatch(/data-testid="easy-brand-input"[^>]*placeholder/);
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-rights-yes"/);
    expect(markup).toContain("是，這是我自己拍的素材");
    expect(markup).toContain("不是，我先自己剪");
    const file = reduce(storyStates().home, { type: "pick-started" }, { type: "pick-finished", video: portrait, check: { ok: true, plan: shortsPlan },
      rights: { kind: "ask", scope: { name: "IMG_4022.MOV", kind: "file" } } });
    expect(markupOf(file)).toContain("選「是」，就表示這支影片是你自己拍的。以後不會再問。");
  });

  it("writes nothing until the yes button: the click goes to the engine with the typed name, no stops at the honest screen", async () => {
    const confirm = vi.fn(async () => undefined);
    const engine: EasyAutoEditEngine = { ...instantDemo(), check: () => ({ ok: true, plan: shortsPlan }),
      rights: { status: async () => ({ kind: "ask", scope: { name: "videos", kind: "folder" } }), confirm } };
    const h = harness(engine);
    h.controller.chooseFormat("vertical");
    await h.controller.chooseVideo();
    expect(h.store.getState().screen).toBe("rights");
    expect(confirm).not.toHaveBeenCalled();
    byTestId(h.tree(), "easy-brand-input").props.onChange({ currentTarget: { value: "小・明" } });
    expect(h.html()).toContain("「・」這個字沒辦法放上畫面，請換一個字");
    h.tree().find(element => element.type === "form")!.props.onSubmit({ preventDefault: () => undefined });
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    // A letter the template could draw but the desktop will not write into the rights file is refused here, not by a failed save.
    byTestId(h.tree(), "easy-brand-input").props.onChange({ currentTarget: { value: "Café" } });
    expect(h.html()).toContain("「é」這個字沒辦法放上畫面，請換一個字");
    h.tree().find(element => element.type === "form")!.props.onSubmit({ preventDefault: () => undefined });
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    byTestId(h.tree(), "easy-brand-input").props.onChange({ currentTarget: { value: "小明的旅行" } });
    h.tree().find(element => element.type === "form")!.props.onSubmit({ preventDefault: () => undefined });
    await flush();
    expect(confirm).toHaveBeenCalledWith(portrait, { brandName: "小明的旅行" });
    expect(h.store.getState().screen).toBe("genre");
    const no = harness(engine);
    no.controller.chooseFormat("vertical");
    await no.controller.chooseVideo();
    byTestId(no.tree(), "easy-rights-no").props.onClick();
    expect(no.store.getState()).toMatchObject({ screen: "unavailable", unavailable: "not-own-footage" });
    expect(no.html()).toContain("只能用你自己拍的影片");
  });

  it("3a 「大家原本以為……」 can be skipped, shows an example and counts 24 characters", () => {
    const markup = markupOf(reduce(storyStates().genre, { type: "show-hook" }));
    expect(markup).toContain("大家原本以為……");
    expect(markup).toContain("這一步可以不寫");
    expect(markup).toContain("例如：來看蝙蝠");
    expect(markup).toContain("還可以打 24 個字");
    expect(markup).toContain("第 3 步，共 4 步");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-hook-next"/);
    expect(markup).toContain("跳過這一步");
    expect(markupOf(reduce(storyStates().genre, { type: "show-hook" }, { type: "set-hook", value: "來看→蝙蝠" }))).toContain("「→」這個字沒辦法放上畫面，請換一個字");
  });

  it("3b 「其實是……」 repeats the creator's hook, needs a title of at most 32 characters and starts the run", () => {
    const markup = markupOf(storyStates().title);
    expect(markup).toContain("其實是……");
    expect(markup).toContain("大家原本以為「Bats」，其實是什麼？");
    expect(markup).toContain("大標題（一定要寫）");
    expect(markup).toContain("還可以打 23 個字");
    expect(markup).toContain("店名、價格、數字請照實寫，電腦不會自己亂加。");
    expect(markup).not.toContain("一句說明");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/type="submit"[^>]*data-easy-primary=""[^>]*data-testid="easy-start"/);
    const skipped = reduce(storyStates().genre, { type: "show-hook" }, { type: "hook-done", skipped: true });
    const skippedMarkup = markupOf(skipped);
    expect(skippedMarkup).toContain("寫一句最想讓大家知道的話。");
    expect(skippedMarkup).toContain("第 4 步，共 5 步");
    expect(skippedMarkup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-title-next"/);
  });

  it("3c asks for 2–4 short points only after the hook was skipped", () => {
    const markup = markupOf(storyStates().points);
    expect(markup).toContain("重點是哪幾個？");
    expect(markup).toContain("重點 1");
    expect(markup).toContain("重點 3（可以不寫）");
    expect(markup).toContain("例如：洞口就看得到水簾");
    expect(markup.match(/data-testid="easy-point-input-\d"/g)).toHaveLength(4);
    expect(markup).toContain("第 5 步，共 5 步");
    expect(primaryCount(markup)).toBe(1);
    // 至少寫兩個重點 marks only the fields still needed (here: point 2), so the cursor and the red border go to one place.
    const missing = markupOf(reduce(storyStates().points, { type: "set-point", index: 1, value: "" }, { type: "points-missing" }));
    expect(missing).toContain("至少寫兩個重點");
    expect(missing.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(missing).toMatch(/<input[^>]*id="easy-point-input-2"[^>]*aria-invalid="true"/);
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it("the result says which part of the clip was used, lists 「第 N 秒」 flags with jumps, and offers 改文字 but no restyle", () => {
    const h = harness();
    const state = storyStates().result;
    const markup = renderToStaticMarkup(<EasyScreen {...h.props({ state })} />);
    expect(markup).toContain("這支影片比較長，只用了開頭的 15 秒。");
    expect(markup).toContain("需要修改");
    expect(markup).toContain("第 3 秒");
    expect(markup).toContain("動畫卡了一下");
    expect(markup).not.toContain("存之前請先看一遍"); // the flags banner already asks for a look
    byTestId(expand(<EasyScreen {...h.props({ state })} />), "easy-flag-seek").props.onClick();
    expect(h.onSeekPreview).toHaveBeenCalledWith(3);
    expect(markup).toContain("改文字");
    expect(markup).not.toContain("換一種風格");
    expect(primaryCount(markup)).toBe(1);
    const clean = reduce(storyStates().working, { type: "run-finished", runId: 1, result: { orientation: "vertical", previewUrl: "short.mp4", flags: [],
      usedRange: { seconds: 11.3, clamped: false }, review: true } });
    const cleanMarkup = markupOf(clean);
    expect(cleanMarkup).toContain("整支影片都用上了（11.3 秒）。");
    expect(cleanMarkup).toContain("存之前請先看一遍");
    expect(cleanMarkup).toContain("這個樣式還沒有經過完整檢查，存之前請自己看一遍。");
  });

  it("failures say what to do: words → 改文字, not allowed → the editor only, stalled → try again", () => {
    const words = markupOf(storyStates().failed);
    expect(words).toContain("字太多或有特別的字，畫面放不下。改一下文字再試一次。");
    expect(words).toMatch(/data-easy-primary=""[^>]*data-testid="easy-edit-words"/);
    expect(words).toContain("Q3_safe_area");
    const failedWith = (kind: "not-allowed" | "stalled" | "no-space" | "settings") => markupOf(reduce(storyStates().working, { type: "run-failed", runId: 1, problem: { kind } }));
    const notAllowed = failedWith("not-allowed");
    expect(notAllowed).toMatch(/data-easy-primary=""[^>]*data-testid="easy-edit-manually"/);
    expect(notAllowed).not.toContain('data-testid="easy-retry"');
    expect(failedWith("settings")).not.toContain('data-testid="easy-retry"');
    expect(failedWith("settings").match(/data-testid="easy-edit-manually"/g)).toHaveLength(1);
    expect(failedWith("stalled")).toContain("很久都沒有進展，所以先停下來了。");
    expect(failedWith("stalled")).toMatch(/data-easy-primary=""[^>]*data-testid="easy-retry"/);
    expect(failedWith("no-space")).toContain("電腦的空間不夠了。");
    for (const markup of [words, notAllowed, failedWith("stalled")]) expect(primaryCount(markup)).toBe(1);
  });

  it("honest screens for videos it cannot use", () => {
    expect(markupOf(storyStates().unavailable)).toContain("這支影片不在工作資料夾裡");
    const short = reduce(storyStates().home, { type: "pick-started" }, { type: "pick-finished", video: portrait, check: { ok: false, reason: "video-too-short" } });
    expect(markupOf(short)).toContain("直的短影音要用 5 秒以上的影片。");
  });
});

describe("honest states", () => {
  it.each([
    ["shorts-connecting", "直的短影音還不能自動剪"],
    ["video-not-horizontal", "這支影片不是橫著拍的"],
    ["needs-desktop", "這裡還不能自動剪"],
  ] as const)("%s: says so plainly, shows no progress or result, and opens the editor", async (reason, title) => {
    const h = harness(createUnavailableEasyEngine(reason));
    h.controller.chooseFormat("vertical");
    await h.controller.chooseVideo();
    const markup = h.html();
    expect(h.store.getState().screen).toBe("unavailable");
    expect(markup).toContain(title);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("剪好了");
    expect(primaryCount(markup)).toBe(1);
    byTestId(h.tree(), "easy-edit-manually").props.onClick();
    expect(h.host.leaveToEditor).toHaveBeenCalledTimes(1);
    byTestId(h.tree(), "easy-other-video").props.onClick();
    expect(h.host.discardVideo).toHaveBeenCalledTimes(1);
  });

  it("says a failed run left the original alone, keeps the reason one step away and offers 再試一次", () => {
    const states = screenStates(templatePlan, portrait);
    const markup = renderToStaticMarkup(<EasyScreen {...harness().props({ state: states.failed })} />);
    expect(markup).toContain("這次沒有剪成功");
    expect(markup).toContain("原本的影片沒有被改動。");
    expect(markup).toContain("decoder stopped");
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/data-easy-primary=""[^>]*data-testid="easy-retry"/);
  });
});

describe("every screen", () => {
  const all = (plan: EasyEnginePlan, video: EasyVideo): Array<[string, EasyFlowState]> =>
    plan === shortsPlan ? Object.entries(storyStates(video)) : Object.entries(screenStates(plan, video));
  const SHORTS_JARGON = [...JARGON, "模板", "BLOCK", "brief", "workspace", "shortId", "template"];

  it("has at most one primary button, exactly one wherever there is something to press", () => {
    for (const plan of [templatePlan, roughPlan, shortsPlan]) {
      for (const [screen, state] of all(plan, plan === roughPlan ? landscape : portrait)) {
        const count = primaryCount(renderToStaticMarkup(<EasyScreen {...harness().props({ state })} />));
        expect(count, screen).toBe(screen === "working" || screen === "saving" ? 0 : 1);
      }
    }
  });

  it("uses no editor jargon", () => {
    for (const plan of [templatePlan, roughPlan, shortsPlan]) {
      for (const [screen, state] of all(plan, plan === roughPlan ? landscape : portrait)) {
        const visible = text(renderToStaticMarkup(<EasyScreen {...harness().props({ state })} />));
        for (const word of plan === shortsPlan ? SHORTS_JARGON : JARGON) expect(visible, `${screen}: ${word}`).not.toContain(word);
      }
    }
  });

  it.each(UI_LOCALES.filter(locale => locale !== "zh-TW"))("is fully translated in %s", async locale => {
    expect(await interfacePreferences.setLocale(locale)).toBe(true);
    const before = new Set(interfacePreferences.missingKeys());
    for (const plan of [templatePlan, roughPlan, shortsPlan]) {
      for (const [screen, state] of all(plan, plan === roughPlan ? landscape : portrait)) {
        for (const extra of [{}, { canReveal: true }]) {
          const markup = renderToStaticMarkup(<EasyScreen {...harness(instantDemo()).props({ state, ...extra })} />);
          if (locale === "en" || locale === "es") expect(text(markup), `${locale} ${screen}`).not.toMatch(/[\u3400-\u9fff]/);
        }
      }
      const home = harness(createRoughCutEasyEngine({ start: vi.fn(), render: vi.fn() }));
      home.store.dispatch({ type: "choose-format", format: "vertical" });
      renderToStaticMarkup(<EasyScreen {...home.props()} />);
    }
    const added = interfacePreferences.missingKeys().filter(key => !before.has(key) && key.startsWith(`${locale}:`));
    expect(added).toEqual([]);
  });
});
