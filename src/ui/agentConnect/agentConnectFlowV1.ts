import { EDITKIN_AGENT_STARTER_PROMPT, type AgentTarget } from "../../application/agentSetup";
import { agentConnectFailureV1 } from "../../application/agentConnectOutcomeV1";
import { translateUi } from "../i18n/interfacePreferences";
import {
  AGENT_APP_NAME_V1, AGENT_CONNECT_FIX_URL_V1, AGENT_CONNECT_STAGES_V1, AGENT_DOWNLOAD_URL_V1, AGENT_KIT_URL_V1, AGENT_STARTER_REQUEST_MV_NO_FOLDER_V1,
  AGENT_STARTER_REQUEST_MV_V1, AGENT_STARTER_REQUEST_NO_FOLDER_V1, AGENT_STARTER_REQUEST_V1, AGENT_TARGETS_V1,
  agentConnectProblemV1, agentConnectStageOfV1, agentConnectSucceededV1, agentEditkinVersionV1, agentFolderNameV1, agentProblemReportV1,
  agentStarterClipboardV1, type AgentConnectFixV1, type AgentConnectProblemV1, type AgentConnectStageV1,
} from "./agentConnectCopyV1";
import type {
  AgentConnectBridgeV1, AgentConnectHandlerV1, AgentDetectionV1, AgentRuntimeRepairV1, AgentSetupProgressV1, AgentSetupResultV1,
  AgentWorkspaceChoiceV1, AgentWorkspacePickV1, AgentWorkspaceSuggestionV1,
} from "./agentConnectTypesV1";

/**
 * 「讓 AI 幫我剪片」 as three steps and an ending: 1 pick the AI, 2 the work folder, 3 connecting, then success or a
 * problem in plain words. A small store (like the easy flow's): the screens are pure and the dialog only renders the state.
 *
 * Folders travel as native tokens only (single use, 10 minutes): the page shows a name and path, the setup receives the
 * token. Every attempt gets a fresh token (再試一次 asks the native side again).
 */
export type AgentConnectScreenV1 = "pick" | "folder" | "connecting" | "success" | "problem";
export type AgentStageStatusV1 = "waiting" | "running" | "done" | "failed";
export type AgentCopyKindV1 = "starter" | "fallback" | "report" | "url";

/** A folder chosen in step 2: picked with the native picker, or the suggested one (remembered or 文件\Editkin 作品). */
export interface AgentFolderChoiceV1 extends AgentWorkspaceChoiceV1 {
  kind: "picked" | "suggested";
  remembered?: boolean;
  exists?: boolean;
}

export interface AgentFolderStateV1 {
  /** choose: the two big options; confirm: a chosen folder waits for 用這個資料夾; native: an older desktop (its own picker). */
  view: "choose" | "confirm" | "native";
  choice?: AgentFolderChoiceV1;
  /** The suggestion shown under 「還沒有資料夾？幫我建一個」, fetched when step 2 opens. */
  suggestion?: AgentWorkspaceSuggestionV1;
  suggestionState: "idle" | "loading" | "ready" | "failed";
  /** The picker or the suggestion is being asked for. */
  busy?: "pick" | "suggest";
  /** The last pick was refused (an unsafe folder): its plain message, shown on step 2. */
  refused?: { code: "WORKSPACE_UNSAFE" | "UNKNOWN"; message: string; displayName: string; displayPath: string };
}

export interface AgentConnectStateV1 {
  screen: AgentConnectScreenV1;
  /** checking: asking the computer; done: `installed` is known; unknown: no detection (or it failed), both tiles offered. */
  detection: "checking" | "done" | "unknown";
  installed?: AgentDetectionV1;
  repair?: AgentRuntimeRepairV1;
  target?: AgentTarget;
  /** The last page the dialog tried to open in the browser, and whether the browser opened it. */
  page?: { url: string; opened: boolean; purpose: AgentTarget | "kit" | "editkin" };
  folder: AgentFolderStateV1;
  /** The folder of the last attempt (its token is spent), so 再試一次 can ask for a fresh one. */
  lastChoice?: AgentFolderChoiceV1;
  stages: Record<AgentConnectStageV1, AgentStageStatusV1>;
  /** While connecting without a chosen folder: the native folder picker is (or is about to be) on screen. */
  nativePicker: boolean;
  /** 再試一次 is getting a fresh folder token (the picker may be on screen). */
  retrying: boolean;
  result?: AgentSetupResultV1;
  problem?: AgentConnectProblemV1;
  /** 「我自己貼指令」 is open. */
  manualOpen: boolean;
  copied?: { kind: AgentCopyKindV1; ok: boolean };
  editkinVersion?: string;
}

const WAITING: AgentConnectStateV1["stages"] = { helper: "waiting", config: "waiting", hello: "waiting" };
const DONE: AgentConnectStateV1["stages"] = { helper: "done", config: "done", hello: "done" };
const STAGE_ORDER = AGENT_CONNECT_STAGES_V1.map(stage => stage.id);
const NO_FOLDER: AgentFolderStateV1 = { view: "choose", suggestionState: "idle" };

function stagesAt(stage: AgentConnectStageV1, status: "running" | "done" | "failed"): AgentConnectStateV1["stages"] {
  const at = STAGE_ORDER.indexOf(stage);
  return Object.fromEntries(STAGE_ORDER.map((id, index) => [id, index < at ? "done" : index === at ? status : "waiting"])) as AgentConnectStateV1["stages"];
}

const refusal = (pick: AgentWorkspacePickV1): AgentFolderStateV1["refused"] | undefined =>
  !pick.canceled && "refused" in pick && pick.refused
    ? { code: pick.code, message: pick.message, displayName: pick.displayName, displayPath: pick.displayPath } : undefined;
const choiceOf = (pick: AgentWorkspacePickV1): AgentFolderChoiceV1 | undefined =>
  !pick.canceled && !("refused" in pick && pick.refused) && "token" in pick
    ? { token: pick.token, displayName: pick.displayName, displayPath: pick.displayPath, kind: "picked" } : undefined;
const suggested = (suggestion: AgentWorkspaceSuggestionV1): AgentFolderChoiceV1 => ({ token: suggestion.token, displayName: suggestion.displayName,
  displayPath: suggestion.displayPath, kind: "suggested", remembered: suggestion.remembered, exists: suggestion.exists });

export interface AgentConnectFlowOptionsV1 {
  bridge: AgentConnectBridgeV1;
  connect: AgentConnectHandlerV1;
  musicMvMode?: boolean;
  now?: () => Date;
  /** A verified connection (the dialog clears 「重新連一次」 everywhere). */
  onConnected?: () => void;
}

export type AgentConnectFlowV1 = ReturnType<typeof createAgentConnectFlowV1>;

export function createAgentConnectFlowV1({ bridge, connect, musicMvMode = false, now = () => new Date(), onConnected }: AgentConnectFlowOptionsV1) {
  let state: AgentConnectStateV1 = { screen: "pick", detection: bridge.detect ? "checking" : "unknown", folder: NO_FOLDER,
    stages: WAITING, nativePicker: false, retrying: false, manualOpen: false };
  const listeners = new Set<() => void>();
  let detectRun = 0, connectRun = 0, suggestRun = 0;
  const set = (patch: Partial<AgentConnectStateV1>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const setFolder = (patch: Partial<AgentFolderStateV1>) => set({ folder: { ...state.folder, ...patch } });
  const tokenFolders = () => Boolean(bridge.suggestWorkspace || bridge.pickWorkspace);

  const detect = async () => {
    const run = ++detectRun;
    if (!bridge.detect) return set({ detection: "unknown" });
    set({ detection: "checking" });
    try {
      const installed = await bridge.detect();
      if (run !== detectRun) return;
      const found = AGENT_TARGETS_V1.filter(target => installed[target]);
      // One app: it is the choice. Both: keep a choice already made, else Claude Code. None: nothing to choose yet.
      const target = found.length === 1 ? found[0] : found.length > 1 ? (state.target && installed[state.target] ? state.target : "claude") : undefined;
      set({ detection: "done", installed, target, repair: installed.repair });
    } catch {
      if (run === detectRun) set({ detection: "unknown" });
    }
  };

  /** The suggestion under 「還沒有資料夾？幫我建一個」. */
  const loadSuggestion = async () => {
    if (!bridge.suggestWorkspace) return undefined;
    const run = ++suggestRun;
    setFolder({ suggestionState: "loading" });
    try {
      const suggestion = await bridge.suggestWorkspace();
      if (run === suggestRun) setFolder({ suggestion, suggestionState: "ready" });
      return suggestion;
    } catch {
      if (run === suggestRun) setFolder({ suggestion: undefined, suggestionState: "failed" });
      return undefined;
    }
  };

  const enterFolder = () => {
    set({ screen: "folder", copied: undefined, page: undefined,
      folder: tokenFolders() ? { view: "choose", suggestionState: "idle" } : { view: "native", suggestionState: "idle" } });
    void loadSuggestion();
  };

  /** 「選我放影片的資料夾」: the native picker; canceling stays quietly on step 2, an unsafe folder is explained there. */
  const pickFolder = async () => {
    if (!bridge.pickWorkspace || state.folder.busy) return;
    setFolder({ busy: "pick", refused: undefined });
    try {
      const pick = await bridge.pickWorkspace(state.folder.choice?.displayPath ?? state.lastChoice?.displayPath);
      const choice = choiceOf(pick), refused = refusal(pick);
      if (choice) return setFolder({ busy: undefined, view: "confirm", choice });
      setFolder({ busy: undefined, refused, view: refused ? "choose" : state.folder.view });
    } catch {
      setFolder({ busy: undefined });
    }
  };

  /** 「還沒有資料夾？幫我建一個」: the suggested folder, shown for 用這個資料夾 (created only by the setup). */
  const useSuggestion = async () => {
    if (state.folder.busy) return;
    setFolder({ busy: "suggest", refused: undefined });
    const suggestion = state.folder.suggestion ?? await loadSuggestion();
    setFolder({ busy: undefined, ...(suggestion ? { view: "confirm" as const, choice: suggested(suggestion) } : {}) });
  };

  const loadVersion = async () => {
    if (state.editkinVersion || !bridge.buildInfo) return;
    try { set({ editkinVersion: agentEditkinVersionV1(await bridge.buildInfo()) }); } catch { /* The report says "unknown". */ }
  };

  const openPage = async (url: string, purpose: AgentTarget | "kit" | "editkin") => {
    if (bridge.openUrl) {
      try { await bridge.openUrl(url); return set({ page: { url, opened: true, purpose } }); } catch { /* Show the address instead. */ }
    }
    set({ page: { url, opened: false, purpose } });
  };

  const onProgress = (run: number) => (event: AgentSetupProgressV1) => {
    if (run !== connectRun || state.screen !== "connecting") return;
    set({ stages: stagesAt(agentConnectStageOfV1(event.step), event.state), nativePicker: false });
  };

  const runConnect = async (choice: AgentFolderChoiceV1 | undefined) => {
    const target = state.target;
    if (!target || state.screen === "connecting") return;
    const run = ++connectRun;
    set({ screen: "connecting", stages: stagesAt("helper", "running"), nativePicker: !choice, retrying: false, result: undefined, problem: undefined,
      manualOpen: false, copied: undefined, lastChoice: choice });
    let result: AgentSetupResultV1 | undefined;
    try {
      result = await connect(target, { ...(choice ? { workspaceToken: choice.token } : {}), onProgress: onProgress(run) });
    } catch (error) {
      result = agentConnectFailureV1(target, error);
    }
    if (run !== connectRun) return;
    // Closing the folder picker changes nothing: back to the folder step, no error.
    if (!result || result.canceled) return set({ screen: "folder", stages: WAITING, nativePicker: false });
    if (agentConnectSucceededV1(result)) {
      set({ screen: "success", result, stages: DONE, nativePicker: false, repair: state.repair ? { ...state.repair, state: "ok" } : undefined });
      onConnected?.();
      return;
    }
    const problem = agentConnectProblemV1(result);
    const failedStage = problem.step && problem.step !== "detect" ? agentConnectStageOfV1(problem.step) : undefined;
    // The command is already on the clipboard (command_copied): show how to paste it straight away.
    set({ screen: "problem", result, problem, nativePicker: false, manualOpen: problem.code === "MANUAL_STEP" || result.status === "command_copied",
      stages: failedStage ? stagesAt(failedStage, "failed") : WAITING });
    void loadVersion();
  };

  /** A fresh token for the folder of the last attempt (tokens are single use). Undefined: stay where we are. */
  const freshChoice = async (): Promise<AgentFolderChoiceV1 | "native" | undefined> => {
    const last = state.lastChoice;
    if (!last) return "native";
    if (last.kind === "suggested" && bridge.suggestWorkspace) {
      try { return suggested(await bridge.suggestWorkspace()); } catch { return undefined; }
    }
    if (bridge.pickWorkspace) {
      const pick = await bridge.pickWorkspace(last.displayPath).catch(() => undefined);
      if (!pick) return undefined;
      const refused = refusal(pick);
      if (refused) { enterFolder(); setFolder({ refused }); return undefined; }
      return choiceOf(pick);
    }
    return undefined;
  };

  const retry = async () => {
    if (state.retrying || state.screen === "connecting") return;
    set({ retrying: true });
    const choice = await freshChoice();
    set({ retrying: false });
    if (choice === "native") return runConnect(undefined);
    if (choice) return runConnect(choice);
  };

  /** 「重新連一次」 after an update: straight to connecting with the remembered folder, else the folder step. */
  const reconnect = async () => {
    if (!state.target) return;
    if (bridge.suggestWorkspace) {
      try {
        const suggestion = await bridge.suggestWorkspace();
        if (suggestion.remembered) return runConnect(suggested(suggestion));
      } catch { /* Ask for the folder instead. */ }
    }
    enterFolder();
  };

  const folderName = () => (state.lastChoice ?? state.folder.choice)?.displayName ?? agentFolderNameV1(state.result?.workspace);

  /** The friendly request in the interface language (the creator's own words to their AI). */
  const starterRequest = () => {
    const folder = folderName();
    if (musicMvMode) return folder ? translateUi(AGENT_STARTER_REQUEST_MV_V1, { folder }) : translateUi(AGENT_STARTER_REQUEST_MV_NO_FOLDER_V1);
    return folder ? translateUi(AGENT_STARTER_REQUEST_V1, { folder }) : translateUi(AGENT_STARTER_REQUEST_NO_FOLDER_V1);
  };

  const report = () => state.problem ? agentProblemReportV1({ problem: state.problem, target: state.target ?? state.result?.target,
    editkinVersion: state.editkinVersion, status: state.result?.status, at: now() }) : "";

  const copy = async (kind: AgentCopyKindV1) => {
    if (kind === "report") await loadVersion();
    const text = kind === "starter" ? agentStarterClipboardV1(starterRequest(), state.result?.starterPrompt ?? EDITKIN_AGENT_STARTER_PROMPT, musicMvMode)
      : kind === "fallback" ? state.problem?.fallbackCommand ?? ""
        : kind === "report" ? report()
          : state.page?.url ?? "";
    if (!text) return;
    set({ copied: { kind, ok: await bridge.copyText(text) } });
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Called when the dialog opens (a second start only supersedes the first). */
    start: () => { void detect(); },
    busy: () => state.screen === "connecting",
    appName: () => AGENT_APP_NAME_V1[state.target ?? state.result?.target ?? "claude"],
    canOpenPages: () => Boolean(bridge.openUrl),
    folderName,
    starterRequest,
    report,
    detectAgain: () => detect(),
    choose: (target: AgentTarget) => {
      if (state.detection === "done" && !state.installed?.[target]) return;
      set({ target });
    },
    next: () => { if (state.target) enterFolder(); },
    reconnect,
    back: () => set({ screen: "pick", copied: undefined }),
    /** Step 2 from the success screen (換資料夾) or a folder problem: choose again, then connect again. */
    changeFolder: () => enterFolder(),
    pickFolder,
    useSuggestion,
    /** From 「用這個資料夾」 back to the two choices. */
    chooseAgain: () => setFolder({ view: "choose", choice: undefined, refused: undefined }),
    /** 用這個資料夾 (or 選資料夾 on an older desktop). */
    connect: () => runConnect(state.folder.view === "confirm" ? state.folder.choice : undefined),
    retry,
    toggleManual: () => set({ manualOpen: !state.manualOpen }),
    openDownload: (target: AgentTarget) => openPage(AGENT_DOWNLOAD_URL_V1[target], target),
    openKit: () => openPage(AGENT_KIT_URL_V1, "kit"),
    fix: (fix: AgentConnectFixV1) => openPage(AGENT_CONNECT_FIX_URL_V1(fix, state.target ?? "claude"),
      fix === "download" ? state.target ?? "claude" : fix === "update" ? "editkin" : "kit"),
    connectAnother: () => {
      set({ screen: "pick", result: undefined, problem: undefined, manualOpen: false, copied: undefined, page: undefined, stages: WAITING });
      void detect();
    },
    copy,
  };
}
