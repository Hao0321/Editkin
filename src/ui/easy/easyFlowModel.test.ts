import { describe, expect, it } from "vitest";
import { TEMPLATE_SHORT_COPY_LIMITS } from "../../application/templateShortBrief";
import { ROUGH_CUT_STEPS, TEMPLATE_STEPS } from "./easyEngines";
import {
  EASY_BRAND_MAX, EASY_DESCRIPTION_MAX, EASY_HOOK_MAX, EASY_POINT_MAX, EASY_TITLE_MAX, clampText, createEasyFlowStore, easyBriefOf, easyFlowOwnsVideo,
  easyFlowReducer, easyQuestionCount, filledPoints, firstUnsupportedBrandCharacter, firstUnsupportedCharacter, formatEasyClock, initialEasyFlowState, type EasyEnginePlan,
  type EasyFlowAction, type EasyFlowState, type EasyVideo,
} from "./easyFlowModel";

const video: EasyVideo = { id: "asset-1", name: "IMG_4022.MOV", durationSeconds: 42, orientation: "portrait" };
const templatePlan: EasyEnginePlan = { needsTitle: true, steps: TEMPLATE_STEPS, estimateSeconds: 60, canRestyle: true, canEditText: true, rendersPreview: true, canCancel: true };
const roughPlan: EasyEnginePlan = { needsTitle: false, steps: ROUGH_CUT_STEPS, canRestyle: false, canEditText: false, rendersPreview: false, canCancel: false };
const run = (state: EasyFlowState, ...actions: EasyFlowAction[]) => actions.reduce(easyFlowReducer, state);
const atGenre = (plan = templatePlan) => run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
  { type: "pick-finished", video, check: { ok: true, plan } });

describe("easy flow state machine", () => {
  it("starts on the first screen with nothing chosen and the computer choosing the genre", () => {
    const state = initialEasyFlowState();
    expect(state).toMatchObject({ screen: "home", format: undefined, genre: "auto", title: "", picking: false, titleError: false });
    expect(easyFlowOwnsVideo(state)).toBe(false);
  });

  it("asks for a kind of video before choosing a file", () => {
    let state = run(initialEasyFlowState(), { type: "pick-started" });
    expect(state.picking).toBe(false);
    state = run(state, { type: "format-required" });
    expect(state.formatHint).toBe(true);
    state = run(state, { type: "choose-format", format: "horizontal" });
    expect(state).toMatchObject({ format: "horizontal", formatHint: false });
  });

  it("holds the start screen from the moment a video is being brought in", () => {
    const picking = run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" });
    expect(easyFlowOwnsVideo(picking)).toBe(true);
    expect(run(picking, { type: "choose-format", format: "horizontal" }).format).toBe("vertical");
    expect(easyFlowOwnsVideo(run(picking, { type: "pick-ended" }))).toBe(false);
  });

  it("goes to the genre screen when an engine can edit the video, and to the honest screen when none can", () => {
    expect(atGenre()).toMatchObject({ screen: "genre", video, plan: templatePlan, picking: false });
    const honest = run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
      { type: "pick-finished", video, check: { ok: false, reason: "shorts-connecting" } });
    expect(honest).toMatchObject({ screen: "unavailable", unavailable: "shorts-connecting", plan: undefined, run: undefined, result: undefined });
  });

  it("shows the title screen only for engines that put a title on screen", () => {
    expect(run(atGenre(), { type: "show-title" }).screen).toBe("title");
    expect(run(atGenre(roughPlan), { type: "show-title" }).screen).toBe("genre");
    expect(easyQuestionCount(templatePlan)).toBe(3);
    expect(easyQuestionCount(roughPlan)).toBe(2);
  });

  it("requires a title and clears the inline message as soon as one is written", () => {
    let state = run(atGenre(), { type: "show-title" }, { type: "title-missing" });
    expect(state.titleError).toBe(true);
    state = run(state, { type: "set-title", value: "   " });
    expect(state.titleError).toBe(true);
    state = run(state, { type: "set-title", value: "其實是來看水簾的" });
    expect(state.titleError).toBe(false);
  });

  it("limits the title and the note by characters, the same way for CJK and emoji", () => {
    const long = "水".repeat(40), emoji = "🎬".repeat(50);
    expect(Array.from(run(atGenre(), { type: "set-title", value: long }).title)).toHaveLength(EASY_TITLE_MAX);
    expect(Array.from(run(atGenre(), { type: "set-description", value: emoji }).description)).toHaveLength(EASY_DESCRIPTION_MAX);
    expect(clampText("abc", 5)).toBe("abc");
  });

  it("keeps the copy limits equal to the template-short brief slots", () => {
    expect(EASY_TITLE_MAX).toBe(TEMPLATE_SHORT_COPY_LIMITS.payoff);
    expect(EASY_DESCRIPTION_MAX).toBe(TEMPLATE_SHORT_COPY_LIMITS.proof);
    expect(EASY_HOOK_MAX).toBe(TEMPLATE_SHORT_COPY_LIMITS.hook);
    expect(EASY_POINT_MAX).toBe(TEMPLATE_SHORT_COPY_LIMITS.pointLabel);
  });

  it("moves progress forward only, and only for the current run", () => {
    let state = run(atGenre(), { type: "show-title" }, { type: "set-title", value: "標題" }, { type: "run-started", runId: 7, startedAt: 1000, estimateSeconds: 60 });
    expect(state).toMatchObject({ screen: "working", run: { id: 7, step: 0, fraction: 0, estimateSeconds: 60 } });
    state = run(state, { type: "run-progress", runId: 7, step: 1, fraction: 0.5 });
    expect(state.run).toMatchObject({ step: 1, fraction: 0.5 });
    expect(run(state, { type: "run-progress", runId: 7, step: 0, fraction: 0.9 })).toBe(state);
    expect(run(state, { type: "run-progress", runId: 6, step: 3, fraction: 1 })).toBe(state);
    expect(run(state, { type: "run-finished", runId: 6, result: { orientation: "vertical", flags: [] } })).toBe(state);
    const done = run(state, { type: "run-finished", runId: 7, result: { orientation: "vertical", flags: [{ second: 3, kind: "text-cut" }] } });
    expect(done).toMatchObject({ screen: "result", run: undefined, result: { flags: [{ second: 3 }] } });
  });

  it("sends a stopped or failed run back to the question before it", () => {
    const working = run(atGenre(), { type: "show-title" }, { type: "set-title", value: "標題" }, { type: "run-started", runId: 1, startedAt: 0 });
    expect(run(working, { type: "run-canceled", runId: 1 }).screen).toBe("title");
    const failed = run(working, { type: "run-failed", runId: 1, problem: { kind: "engine-failed", detail: "x" } });
    expect(failed).toMatchObject({ screen: "failed", failure: { kind: "engine-failed", detail: "x" } });
    expect(run(failed, { type: "back" }).screen).toBe("title");
    const roughFailed = run(atGenre(roughPlan), { type: "run-started", runId: 2, startedAt: 0 }, { type: "run-failed", runId: 2, problem: { kind: "engine-failed" } });
    expect(run(roughFailed, { type: "back" }).screen).toBe("genre");
  });

  it("offers 改文字 and 換一種風格 only when the engine can do them", () => {
    const result = (plan: EasyEnginePlan) => run(atGenre(plan), { type: "run-started", runId: 1, startedAt: 0 }, { type: "run-finished", runId: 1, result: { orientation: "vertical", flags: [] } });
    expect(run(result(templatePlan), { type: "edit-text" }).screen).toBe("title");
    expect(run(result(templatePlan), { type: "restyle" }).styleVariant).toBe(1);
    expect(run(result(roughPlan), { type: "edit-text" }).screen).toBe("result");
    expect(run(result(roughPlan), { type: "restyle" }).styleVariant).toBe(0);
  });

  it("saves, reports a cancelled save as nothing happened, and keeps the result after a failed save", () => {
    const result = run(atGenre(), { type: "run-started", runId: 1, startedAt: 0 }, { type: "run-finished", runId: 1, result: { orientation: "vertical", flags: [] } });
    const saving = run(result, { type: "save-started" });
    expect(saving.screen).toBe("saving");
    expect(run(saving, { type: "save-canceled" }).screen).toBe("result");
    expect(run(saving, { type: "save-failed", problem: { kind: "save-failed" } })).toMatchObject({ screen: "result", saveProblem: { kind: "save-failed" } });
    expect(run(saving, { type: "save-finished", saved: { fileName: "a.mp4", inVideosFolder: true } })).toMatchObject({ screen: "saved", saved: { fileName: "a.mp4" } });
  });

  it("starts over completely, or keeps only the kind of video when going back to the start", () => {
    const state = run(atGenre(), { type: "show-title" }, { type: "set-title", value: "標題" });
    expect(run(state, { type: "reset" })).toEqual(initialEasyFlowState());
    expect(run(state, { type: "reset", keepFormat: true })).toEqual(initialEasyFlowState("vertical"));
  });

  it("builds the engine brief from trimmed words", () => {
    const state = run(atGenre(), { type: "choose-genre", genre: "food" }, { type: "show-title" }, { type: "set-title", value: "  好吃  " }, { type: "set-description", value: " 一句 " });
    expect(easyBriefOf(state)).toEqual({ format: "vertical", genre: "food", title: "好吃", description: "一句", video, styleVariant: 0 });
    expect(easyBriefOf(initialEasyFlowState())).toBeUndefined();
  });

  it("notifies subscribers only when the state really changes", () => {
    const store = createEasyFlowStore();
    let calls = 0;
    const stop = store.subscribe(() => { calls++; });
    store.dispatch({ type: "edit-text" });
    expect(calls).toBe(0);
    store.dispatch({ type: "choose-format", format: "vertical" });
    expect(calls).toBe(1);
    stop();
    store.dispatch({ type: "choose-format", format: "horizontal" });
    expect(calls).toBe(1);
  });

  describe("template Shorts (story copy)", () => {
    const storyPlan: EasyEnginePlan = { ...templatePlan, copy: "story", canRestyle: false };
    const atStoryGenre = () => run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
      { type: "pick-finished", video, check: { ok: true, plan: storyPlan } });

    it("asks the one-time rights question before the genre, and only an explicit answer leaves it", () => {
      const asking = run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
        { type: "pick-finished", video, check: { ok: true, plan: storyPlan }, rights: { kind: "ask", scope: { name: "videos", kind: "folder" } } });
      expect(asking).toMatchObject({ screen: "rights", rights: { scope: { name: "videos", kind: "folder" }, brandName: "", busy: false } });
      expect(run(asking, { type: "set-brand", value: "名".repeat(20) }).rights?.brandName).toHaveLength(EASY_BRAND_MAX);
      const busy = run(asking, { type: "rights-started" });
      expect(run(busy, { type: "set-brand", value: "x" })).toBe(busy);
      expect(run(busy, { type: "rights-declined" })).toBe(busy);
      expect(run(busy, { type: "rights-failed", problem: { kind: "rights-failed" } }).rights).toMatchObject({ busy: false, problem: { kind: "rights-failed" } });
      expect(run(busy, { type: "rights-confirmed" })).toMatchObject({ screen: "genre", rights: undefined });
      expect(run(asking, { type: "rights-declined" })).toMatchObject({ screen: "unavailable", unavailable: "not-own-footage", plan: undefined });
      const outside = run(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
        { type: "pick-finished", video, check: { ok: true, plan: storyPlan }, rights: { kind: "unavailable", reason: "outside-workspace" } });
      expect(outside).toMatchObject({ screen: "unavailable", unavailable: "outside-workspace" });
    });

    it("walks 原本以為 → 其實是, or 其實是 → 2–4 points after a skip, and back again", () => {
      const genre = atStoryGenre();
      expect(run(genre, { type: "show-title" })).toBe(genre);
      const hook = run(genre, { type: "show-hook" }, { type: "set-hook", value: "蝙".repeat(30) });
      expect(hook).toMatchObject({ screen: "hook" });
      expect(Array.from(hook.hook)).toHaveLength(EASY_HOOK_MAX);
      const title = run(hook, { type: "hook-done", skipped: false });
      expect(title).toMatchObject({ screen: "title", hookSkipped: false });
      expect(run(title, { type: "show-points" })).toBe(title);
      expect(run(title, { type: "back" }).screen).toBe("hook");
      const skipped = run(hook, { type: "hook-done", skipped: true });
      expect(skipped).toMatchObject({ screen: "title", hookSkipped: true, hook: "" });
      const points = run(skipped, { type: "set-title", value: "其實是" }, { type: "show-points" }, { type: "set-point", index: 0, value: "點".repeat(30) });
      expect(points.screen).toBe("points");
      expect(Array.from(points.points[0])).toHaveLength(EASY_POINT_MAX);
      expect(run(points, { type: "set-point", index: 9, value: "x" })).toBe(points);
      const missing = run(points, { type: "points-missing" });
      expect(missing.pointsError).toBe(true);
      expect(run(missing, { type: "set-point", index: 1, value: "第二點" }).pointsError).toBe(false);
      expect(run(points, { type: "back" }).screen).toBe("title");
      expect(run(points, { type: "back" }, { type: "back" }, { type: "back" }).screen).toBe("genre");
    });

    it("returns a stopped or failed run to the last question, and 改文字 to the first word question", () => {
      const withHook = run(atStoryGenre(), { type: "show-hook" }, { type: "set-hook", value: "原本" }, { type: "hook-done", skipped: false },
        { type: "set-title", value: "其實" }, { type: "run-started", runId: 1, startedAt: 0 });
      expect(run(withHook, { type: "run-canceled", runId: 1 }).screen).toBe("title");
      const withPoints = run(atStoryGenre(), { type: "show-hook" }, { type: "hook-done", skipped: true }, { type: "set-title", value: "其實" }, { type: "show-points" },
        { type: "set-point", index: 0, value: "一" }, { type: "set-point", index: 1, value: "二" }, { type: "run-started", runId: 2, startedAt: 0 });
      expect(withPoints.screen).toBe("working");
      expect(run(withPoints, { type: "run-canceled", runId: 2 }).screen).toBe("points");
      const failed = run(withPoints, { type: "run-failed", runId: 2, problem: { kind: "words" } });
      expect(run(failed, { type: "back" }).screen).toBe("points");
      expect(run(failed, { type: "edit-text" })).toMatchObject({ screen: "hook", failure: undefined, title: "其實", points: ["一", "二", "", ""] });
      const result = run(withHook, { type: "run-finished", runId: 1, result: { orientation: "vertical", flags: [] } });
      expect(run(result, { type: "edit-text" }).screen).toBe("hook");
      expect(run(result, { type: "result-problem", problem: { kind: "open-failed" } }).saveProblem).toEqual({ kind: "open-failed" });
    });

    it("builds the brief from the creator's words only: a hook, or the filled points", () => {
      const withHook = run(atStoryGenre(), { type: "show-hook" }, { type: "set-hook", value: " 來看蝙蝠 " }, { type: "hook-done", skipped: false },
        { type: "set-title", value: " 其實是來看水簾的 " });
      expect(easyBriefOf(withHook)).toEqual({ format: "vertical", genre: "auto", title: "其實是來看水簾的", description: "", video, styleVariant: 0, hook: "來看蝙蝠" });
      const withPoints = run(atStoryGenre(), { type: "show-hook" }, { type: "hook-done", skipped: true }, { type: "set-title", value: "其實" }, { type: "show-points" },
        { type: "set-point", index: 0, value: " 一 " }, { type: "set-point", index: 2, value: "三" });
      expect(easyBriefOf(withPoints)).toMatchObject({ points: ["一", "三"] });
      expect(easyBriefOf(withPoints)?.hook).toBeUndefined();
      expect(easyQuestionCount(storyPlan)).toBe(4);
      expect(easyQuestionCount(storyPlan, true)).toBe(5);
    });

    it("names the first character the Short cannot put on screen", () => {
      expect(firstUnsupportedCharacter("其實是來看水簾的 ABC 123，！")).toBeUndefined();
      expect(firstUnsupportedCharacter("來看・蝙蝠")).toBe("・");
      expect(firstUnsupportedCharacter("好吃🍜")).toBe("🍜");
      expect(firstUnsupportedCharacter("一\n二")).toBe("\n");
      expect(firstUnsupportedCharacter("𠮷野家")).toBe("𠮷");
      expect(filledPoints([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
    });

    it("checks the name or brand against the narrower set the desktop writes into the rights file", () => {
      for (const ok of ["Hao0321 Studio", "駱君昊", "小明的旅行", "《阿明》【旅行】", "ＡＢＣ！", "A&B-c_d.e", ""]) expect(firstUnsupportedBrandCharacter(ok)).toBeUndefined();
      // é and — are drawable in the copy, but validate_brand_mark (src-tauri/src/template_short.rs) refuses them.
      expect(firstUnsupportedCharacter("Café — 旅行")).toBeUndefined();
      expect(firstUnsupportedBrandCharacter("Café")).toBe("é");
      expect(firstUnsupportedBrandCharacter("旅行—日記")).toBe("—");
      expect(firstUnsupportedBrandCharacter("小・明")).toBe("・");
      expect(firstUnsupportedBrandCharacter("好吃🍜")).toBe("🍜");
      expect(firstUnsupportedBrandCharacter("一\t二")).toBe("\t");
    });
  });

  it("formats times with digits only", () => {
    expect(formatEasyClock(42)).toBe("0:42");
    expect(formatEasyClock(725)).toBe("12:05");
    expect(formatEasyClock(3723)).toBe("1:02:03");
    expect(formatEasyClock(Number.NaN)).toBe("0:00");
  });
});
