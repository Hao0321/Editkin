import { EasyEngineError } from "./easyEngines";
import type { EasyChooseOutcome, EasyFlowHost } from "./easyFlowHost";
import {
  EASY_POINTS_MIN, easyBriefOf, filledPoints, firstUnsupportedBrandCharacter, firstUnsupportedCharacter, type EasyFormat, type EasyGenre, type EasyProblem, type EasyRightsStatus,
} from "./easyFlowModel";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function problemFor(outcome: Exclude<EasyChooseOutcome, { kind: "video" }>): EasyProblem | undefined {
  switch (outcome.kind) {
    case "failed": return { kind: "import-failed", detail: outcome.detail };
    case "not-video": return { kind: "not-video" };
    case "too-many": return { kind: "too-many" };
    default: return undefined; // The chooser was closed: nothing to say.
  }
}

/**
 * Side effects of the easy flow: choosing the video, running the engine, saving.
 * Screens call these; all state changes go through the store's reducer.
 */
export function createEasyFlowController(host: EasyFlowHost, clock: () => number = Date.now) {
  const { store } = host;
  let runAbort: AbortController | undefined;
  let runCounter = 0;

  const startRun = async () => {
    const state = store.getState();
    const brief = easyBriefOf(state);
    if (!brief || !state.plan) return;
    runAbort?.abort();
    const abort = new AbortController();
    runAbort = abort;
    const runId = ++runCounter;
    store.dispatch({ type: "run-started", runId, startedAt: clock(), estimateSeconds: state.plan.estimateSeconds });
    if (store.getState().run?.id !== runId) return;
    try {
      const result = await host.engine.start(brief, progress => {
        if (!abort.signal.aborted) store.dispatch({ type: "run-progress", runId, ...progress });
      }, abort.signal);
      if (!abort.signal.aborted) store.dispatch({ type: "run-finished", runId, result });
    } catch (error) {
      // An engine can name a plainer reason (words that do not fit, no disk space…); anything else is a plain failure.
      const kind = error instanceof EasyEngineError && error.kind ? error.kind : "engine-failed";
      if (!abort.signal.aborted) store.dispatch({ type: "run-failed", runId, problem: { kind, detail: messageOf(error) } });
    } finally {
      if (runAbort === abort) runAbort = undefined;
    }
  };

  const stopRun = () => { runAbort?.abort(); runAbort = undefined; };
  const wordsFit = (...values: string[]) => values.every(value => firstUnsupportedCharacter(value) === undefined);

  return {
    chooseFormat: (format: EasyFormat) => store.dispatch({ type: "choose-format", format }),

    /** The first screen's primary button. Returns false when a kind of video must be chosen first. */
    canChooseVideo: () => {
      const state = store.getState();
      if (state.picking) return false;
      if (!state.format) { store.dispatch({ type: "format-required" }); return false; }
      return true;
    },

    chooseVideo: async (files?: readonly File[]) => {
      const state = store.getState();
      if (state.picking || state.screen !== "home") return;
      if (!state.format) { store.dispatch({ type: "format-required" }); return; }
      store.dispatch({ type: "pick-started" });
      let outcome: EasyChooseOutcome;
      try { outcome = await host.chooseVideo(files); } catch (error) { outcome = { kind: "failed", detail: messageOf(error) }; }
      if (outcome.kind !== "video") { store.dispatch({ type: "pick-ended", problem: problemFor(outcome) }); return; }
      const format = store.getState().format ?? state.format;
      const check = host.engine.check(format, outcome.video);
      // Engines that may only use the creator's own footage ask once (still on the first screen, while it says 正在放進來…).
      let rights: EasyRightsStatus | undefined;
      if (check.ok && host.engine.rights) {
        try { rights = await host.engine.rights.status(format, outcome.video); }
        catch { rights = { kind: "unavailable", reason: "check-failed" }; }
      }
      store.dispatch({ type: "pick-finished", video: outcome.video, check, rights });
    },

    setBrandName: (value: string) => store.dispatch({ type: "set-brand", value }),
    /** 「是，這是我自己拍的素材」: the only path that may record the creator's confirmation. */
    confirmRights: async () => {
      const state = store.getState();
      const rights = state.rights, engine = host.engine.rights;
      if (state.screen !== "rights" || !rights || rights.busy || !state.video || !engine || firstUnsupportedBrandCharacter(rights.brandName) !== undefined) return;
      store.dispatch({ type: "rights-started" });
      try {
        await engine.confirm(state.video, { brandName: rights.brandName.trim() });
        store.dispatch({ type: "rights-confirmed" });
      } catch (error) {
        store.dispatch({ type: "rights-failed", problem: { kind: "rights-failed", detail: messageOf(error) } });
      }
    },
    declineRights: () => store.dispatch({ type: "rights-declined" }),

    chooseGenre: (genre: EasyGenre) => store.dispatch({ type: "choose-genre", genre }),

    /** Genre screen primary: the word questions when the engine writes words, otherwise start right away. */
    confirmGenre: () => {
      const state = store.getState();
      if (state.screen !== "genre") return;
      if (state.plan?.copy === "story") store.dispatch({ type: "show-hook" });
      else if (state.plan?.needsTitle) store.dispatch({ type: "show-title" });
      else void startRun();
    },

    setHook: (value: string) => store.dispatch({ type: "set-hook", value }),
    /** 大家原本以為… : 下一步 with nothing written is the same as skipping. */
    submitHook: () => {
      const state = store.getState();
      if (state.screen !== "hook" || !wordsFit(state.hook)) return false;
      store.dispatch({ type: "hook-done", skipped: !state.hook.trim() });
      return true;
    },
    skipHook: () => store.dispatch({ type: "hook-done", skipped: true }),

    setTitle: (value: string) => store.dispatch({ type: "set-title", value }),
    setDescription: (value: string) => store.dispatch({ type: "set-description", value }),

    /** Title screen primary. An empty title stays on the screen with the inline 先寫一句大標題 message. */
    submitTitle: () => {
      const state = store.getState();
      if (state.screen !== "title") return false;
      if (!state.title.trim()) { store.dispatch({ type: "title-missing" }); return false; }
      if (state.plan?.copy === "story") {
        if (!wordsFit(state.title)) return false;
        if (state.hookSkipped) { store.dispatch({ type: "show-points" }); return true; }
      }
      void startRun();
      return true;
    },

    setPoint: (index: number, value: string) => store.dispatch({ type: "set-point", index, value }),
    /** 重點 primary: at least two points, every character printable. */
    submitPoints: () => {
      const state = store.getState();
      if (state.screen !== "points" || !wordsFit(...state.points)) return false;
      if (filledPoints(state.points).length < EASY_POINTS_MIN) { store.dispatch({ type: "points-missing" }); return false; }
      void startRun();
      return true;
    },

    cancelRun: () => {
      const run = store.getState().run;
      if (!run || !store.getState().plan?.canCancel) return;
      stopRun();
      store.dispatch({ type: "run-canceled", runId: run.id });
    },

    retry: () => { if (store.getState().screen === "failed") void startRun(); },

    editText: () => store.dispatch({ type: "edit-text" }),

    restyle: () => {
      const before = store.getState().styleVariant;
      store.dispatch({ type: "restyle" });
      if (store.getState().styleVariant !== before) void startRun();
    },

    save: async () => {
      const state = store.getState();
      const brief = easyBriefOf(state);
      if (state.screen !== "result" || !state.result || !brief) return;
      store.dispatch({ type: "save-started" });
      try {
        const saved = await host.engine.saveVideo(state.result, brief);
        store.dispatch(saved ? { type: "save-finished", saved } : { type: "save-canceled" });
      } catch (error) {
        store.dispatch({ type: "save-failed", problem: { kind: "save-failed", detail: messageOf(error) } });
      }
    },

    canReveal: () => Boolean(host.engine.revealInFolder),
    reveal: async () => {
      const saved = store.getState().saved;
      if (saved && host.engine.revealInFolder) await host.engine.revealInFolder(saved).catch(() => undefined);
    },

    /** Back to the previous question. Leaving the first question after the video puts the chosen video away again. */
    back: () => {
      const state = store.getState();
      if (state.screen === "genre" || state.screen === "unavailable" || (state.screen === "rights" && !state.rights?.busy)) {
        host.discardVideo();
        store.dispatch({ type: "reset", keepFormat: true });
        return;
      }
      store.dispatch({ type: "back" });
    },

    /** 再做一支: the finished video is saved; start fresh. */
    startOver: () => {
      stopRun();
      host.discardVideo();
      store.dispatch({ type: "reset" });
    },

    /** 我想自己細調 / 到剪輯台自己剪: keep what was made and open the editor. */
    openEditor: () => { stopRun(); host.leaveToEditor(); },
    openWorkspace: () => host.openWorkspace(),
    openProject: () => host.openProject(),
  };
}

export type EasyFlowController = ReturnType<typeof createEasyFlowController>;
