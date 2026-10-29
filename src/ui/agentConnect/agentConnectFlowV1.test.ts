import { describe, expect, it, vi } from "vitest";
import { EDITKIN_AGENT_STARTER_PROMPT, type AgentTarget } from "../../application/agentSetup";
import {
  AGENT_CONNECT_PROBLEM_COPY_V1, AGENT_DOWNLOAD_URL_V1, AGENT_EXTERNAL_URLS_V1, AGENT_KIT_URL_V1, EDITKIN_RELEASES_URL_V1, agentConnectPrimaryV1,
  agentConnectProblemV1, agentProblemReportV1,
} from "./agentConnectCopyV1";
import { createAgentConnectFlowV1 } from "./agentConnectFlowV1";
import { createAgentRuntimeRepairStoreV1 } from "./agentRuntimeRepairV1";
import {
  AGENT_SETUP_FAILURE_CODES_V1, type AgentConnectBridgeV1, type AgentConnectRequestV1, type AgentDetectionV1, type AgentSetupFailureCodeV1,
  type AgentSetupResultV1, type AgentSetupStepV1, type AgentWorkspacePickV1,
} from "./agentConnectTypesV1";

// 2026-10-29 「讓 AI 幫我剪片」: the flow behind the dialog, driven with a fake desktop bridge (no native dialogs or CLIs).
// Folders travel as native tokens only; every attempt gets a fresh one.
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const DOCS = "C:\\Users\\Ama\\Documents\\Editkin 作品";
const OK: AgentSetupResultV1 = { canceled: false, target: "claude", status: "installed", health: "connected", runtimeVerified: true, runtimeToolCount: 104,
  starterPrompt: "完整剪輯規則", workspace: DOCS, clientRestartRequired: true, vaSkill: { installed: true }, configChange: "added" };
const CMD = "cmd /d /c call \"%LOCALAPPDATA%\\Editkin\\agent-connect\\Connect Editkin to Claude Code.cmd\" --no-pause";
const STEP_OF: Record<AgentSetupFailureCodeV1, AgentSetupStepV1> = {
  AGENT_APP_NOT_FOUND: "detect", RUNTIME_FILES_MISSING: "prepare_runtime", RUNTIME_PROBE_FAILED: "probe", WORKSPACE_NOT_WRITABLE: "prepare_runtime",
  WORKSPACE_CHOICE_EXPIRED: "detect", WORKSPACE_UNSAFE: "detect",
  CONFIG_WRITE_REFUSED: "write_config", CONFIG_ALREADY_EXISTS_DIFFERENT: "write_config", HEALTH_CHECK_FAILED: "health_check", UNKNOWN: "probe",
};
const failed = (code: AgentSetupFailureCodeV1, extra: Partial<AgentSetupResultV1> = {}): AgentSetupResultV1 => ({
  canceled: false, target: "claude", status: "failed", health: "failed",
  failure: { step: STEP_OF[code], code, detail: `native detail for ${code}`, logPath: "%USERPROFILE%\\AppData\\Roaming\\studio.hao.editkin\\logs\\agent-connect.log" },
  fallbackCommand: CMD, ...extra,
});

function setup(options: { installed?: AgentDetectionV1 | "none-api" | "throws"; suggest?: boolean; pick?: boolean; openUrl?: boolean | "rejects";
  remembered?: boolean; picks?: AgentWorkspacePickV1[]; results?: Array<AgentSetupResultV1 | Error | undefined>; musicMvMode?: boolean } = {}) {
  const calls: Array<{ target: AgentTarget; request?: AgentConnectRequestV1 }> = [];
  const results = [...(options.results ?? [OK])];
  const picks = [...(options.picks ?? [])];
  const copied: string[] = [];
  let suggestions = 0, pickTokens = 0;
  const bridge: AgentConnectBridgeV1 = {
    detect: options.installed === "none-api" ? undefined : vi.fn(async () => {
      if (options.installed === "throws") throw new Error("runtime missing");
      return (options.installed as AgentDetectionV1 | undefined) ?? { claude: true, codex: false };
    }),
    openUrl: options.openUrl === false ? undefined : vi.fn(async () => { if (options.openUrl === "rejects") throw new Error("refused"); }),
    suggestWorkspace: options.suggest === false ? undefined : vi.fn(async () => ({ token: `suggest-${++suggestions}`, displayName: "Editkin 作品", displayPath: DOCS,
      exists: false, remembered: options.remembered === true })),
    pickWorkspace: options.pick === false ? undefined : vi.fn(async () => picks.length ? picks.shift()!
      : { canceled: false as const, token: `pick-${++pickTokens}`, displayName: "Trip", displayPath: "D:\\Videos\\Trip" }),
    buildInfo: vi.fn(async () => ({ version: "0.15.0", productVersion: "0.15.0", buildId: "1a2b3c4", buildIdFull: "1a2b3c4d5e", edition: "official" as const })),
    copyText: vi.fn(async (text: string) => { copied.push(text); return true; }),
  };
  const connect = vi.fn(async (target: AgentTarget, request?: AgentConnectRequestV1) => {
    calls.push({ target, request });
    const next = results.length > 1 ? results.shift() : results[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const onConnected = vi.fn();
  const flow = createAgentConnectFlowV1({ bridge, connect, musicMvMode: options.musicMvMode, now: () => new Date("2026-10-29T08:00:00Z"), onConnected });
  return { flow, bridge, connect, calls, copied, onConnected };
}

async function toFolder(t: ReturnType<typeof setup>) {
  t.flow.start(); await flush();
  t.flow.next(); await flush();
}
/** Step 2 with 「還沒有資料夾？幫我建一個」, then 用這個資料夾. */
async function connectSuggested(t: ReturnType<typeof setup>) {
  await toFolder(t);
  await t.flow.useSuggestion();
  await t.flow.connect();
}

describe("step 1: pick the AI from what this computer has", () => {
  it("one app installed: it is preselected and 下一步 is ready", async () => {
    const t = setup({ installed: { claude: true, codex: false } });
    expect(t.flow.getState().detection).toBe("checking");
    t.flow.start(); await flush();
    expect(t.flow.getState()).toMatchObject({ detection: "done", target: "claude", screen: "pick" });
    t.flow.choose("codex");
    expect(t.flow.getState().target).toBe("claude"); // a missing app cannot be chosen
  });
  it("none installed: nothing is chosen, each app's official page opens in the browser, and 再找一次 asks again", async () => {
    const t = setup({ installed: { claude: false, codex: false } });
    t.flow.start(); await flush();
    expect(t.flow.getState().target).toBeUndefined();
    t.flow.next();
    expect(t.flow.getState().screen).toBe("pick");
    await t.flow.openDownload("claude");
    expect(t.bridge.openUrl).toHaveBeenCalledWith(AGENT_DOWNLOAD_URL_V1.claude);
    expect(t.flow.getState().page).toEqual({ url: AGENT_DOWNLOAD_URL_V1.claude, opened: true, purpose: "claude" });
    await t.flow.openDownload("codex");
    expect(t.bridge.openUrl).toHaveBeenLastCalledWith(AGENT_DOWNLOAD_URL_V1.codex);
    await t.flow.detectAgain();
    expect(t.bridge.detect).toHaveBeenCalledTimes(2);
  });
  it("without a browser bridge, or when the browser refuses, the address is shown with 複製網址", async () => {
    for (const openUrl of [false, "rejects"] as const) {
      const t = setup({ installed: { claude: false, codex: false }, openUrl });
      t.flow.start(); await flush();
      await t.flow.openDownload("codex");
      expect(t.flow.getState().page).toEqual({ url: AGENT_DOWNLOAD_URL_V1.codex, opened: false, purpose: "codex" });
      await t.flow.copy("url");
      expect(t.copied).toEqual([AGENT_DOWNLOAD_URL_V1.codex]);
    }
  });
  it("only ever opens the four allow-listed official pages", () => {
    expect([...AGENT_EXTERNAL_URLS_V1].sort()).toEqual([
      "https://code.claude.com/docs/en/setup", "https://github.com/Hao0321/Editkin/releases", "https://github.com/Hao0321/video-autopilot-kit", "https://github.com/openai/codex",
    ]);
  });
  it("both installed: Claude Code is preselected and Codex can be chosen", async () => {
    const t = setup({ installed: { claude: true, codex: true } });
    t.flow.start(); await flush();
    expect(t.flow.getState().target).toBe("claude");
    t.flow.choose("codex");
    await t.flow.detectAgain();
    expect(t.flow.getState().target).toBe("codex"); // a choice already made survives 再找一次
  });
  it("no detection (or it fails): both apps are offered and nothing is preselected", async () => {
    for (const installed of ["none-api", "throws"] as const) {
      const t = setup({ installed });
      t.flow.start(); await flush();
      expect(t.flow.getState().detection).toBe("unknown");
      expect(t.flow.getState().target).toBeUndefined();
      t.flow.choose("codex");
      expect(t.flow.getState().target).toBe("codex");
    }
  });
});

describe("after an Editkin update whose refresh failed: 重新連一次", () => {
  const repair = { state: "failed" as const, message: "generation pointer mismatch" };
  it("with a remembered folder it connects straight away with a fresh token, and clears the state", async () => {
    const t = setup({ installed: { claude: true, codex: false, repair }, remembered: true });
    t.flow.start(); await flush();
    expect(t.flow.getState().repair).toEqual(repair);
    await t.flow.reconnect();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].request?.workspaceToken).toBe("suggest-1");
    expect(t.flow.getState().screen).toBe("success");
    expect(t.flow.getState().repair?.state).toBe("ok");
    expect(t.onConnected).toHaveBeenCalledOnce();
  });
  it("without a remembered folder it goes to step 2 first", async () => {
    const t = setup({ installed: { claude: true, codex: false, repair } });
    t.flow.start(); await flush();
    await t.flow.reconnect(); await flush();
    expect(t.flow.getState().screen).toBe("folder");
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("the shared state the entry points read: failed until a connect, a pending refresh is asked again", async () => {
    const scheduled: Array<() => void> = [];
    const store = createAgentRuntimeRepairStoreV1({ schedule: run => scheduled.push(run) });
    let answer: "pending" | "failed" = "pending";
    const inspect = vi.fn(async () => ({ claude: {}, codex: {}, checkedAt: 0, agentRuntimeRepair: { state: answer } }) as never);
    store.ensure({ inspectAgentConnections: inspect }); await flush();
    expect(store.get().state).toBe("pending");
    store.ensure({ inspectAgentConnections: inspect }); await flush();
    expect(inspect).toHaveBeenCalledTimes(1); // once per session
    answer = "failed";
    scheduled.shift()!(); await flush();
    expect(store.get().state).toBe("failed");
    store.markConnected();
    expect(store.get().state).toBe("ok");
  });
});

describe("step 2: the work folder — two equal choices, tokens only", () => {
  it("opens on the two choices with the suggestion ready under 幫我建一個", async () => {
    const t = setup();
    await toFolder(t);
    expect(t.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose", suggestionState: "ready", suggestion: { displayName: "Editkin 作品", displayPath: DOCS } } });
  });
  it("選我放影片的資料夾: the picker's folder is shown for 用這個資料夾, and only its token goes to the setup", async () => {
    const t = setup();
    await toFolder(t);
    await t.flow.pickFolder();
    expect(t.flow.getState().folder).toMatchObject({ view: "confirm", choice: { kind: "picked", token: "pick-1", displayName: "Trip", displayPath: "D:\\Videos\\Trip" } });
    await t.flow.connect();
    expect(t.calls[0].request).toEqual({ workspaceToken: "pick-1", onProgress: expect.any(Function) });
    expect(JSON.stringify(t.calls[0].request)).not.toContain("Videos");
  });
  it("closing the picker stays quietly on step 2; an unsafe folder is explained there", async () => {
    const t = setup({ picks: [{ canceled: true }, { canceled: false, refused: true, code: "WORKSPACE_UNSAFE", message: "磁碟根目錄不能當工作資料夾", displayName: "C:", displayPath: "C:\\" }] });
    await toFolder(t);
    await t.flow.pickFolder();
    expect(t.flow.getState().folder.view).toBe("choose");
    expect(t.flow.getState().folder.refused).toBeUndefined();
    await t.flow.pickFolder();
    expect(t.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose", refused: { code: "WORKSPACE_UNSAFE", displayPath: "C:\\" } } });
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("還沒有資料夾？幫我建一個: the suggested folder (remembered when it was used before) and its token", async () => {
    const t = setup({ remembered: true });
    await toFolder(t);
    await t.flow.useSuggestion();
    expect(t.flow.getState().folder).toMatchObject({ view: "confirm", choice: { kind: "suggested", token: "suggest-1", remembered: true } });
    t.flow.chooseAgain();
    expect(t.flow.getState().folder.view).toBe("choose");
    await t.flow.useSuggestion();
    await t.flow.connect();
    expect(t.calls[0].request?.workspaceToken).toBe("suggest-1");
  });
  it("live progress marks the three steps as the native side reports them, including a failed one", async () => {
    const t = setup();
    await toFolder(t);
    await t.flow.useSuggestion();
    let release!: (value: AgentSetupResultV1) => void;
    t.connect.mockImplementationOnce(async (target, request) => { t.calls.push({ target, request }); return new Promise(resolve => { release = resolve; }); });
    const running = t.flow.connect();
    expect(t.flow.getState()).toMatchObject({ screen: "connecting", nativePicker: false, stages: { helper: "running", config: "waiting", hello: "waiting" } });
    expect(t.flow.busy()).toBe(true);
    const progress = t.calls[0].request!.onProgress!;
    progress({ step: "prepare_runtime", state: "done" });
    expect(t.flow.getState().stages).toEqual({ helper: "done", config: "waiting", hello: "waiting" });
    progress({ step: "write_config", state: "running" });
    expect(t.flow.getState().stages).toEqual({ helper: "done", config: "running", hello: "waiting" });
    progress({ step: "write_config", state: "done" });
    progress({ step: "health_check", state: "failed" });
    expect(t.flow.getState().stages).toEqual({ helper: "done", config: "done", hello: "failed" });
    release(failed("HEALTH_CHECK_FAILED")); await running;
    expect(t.flow.getState()).toMatchObject({ screen: "problem", stages: { helper: "done", config: "done", hello: "failed" } });
  });
  it("an older desktop (no folder bridge): the setup's own folder picker asks, and closing it returns to step 2 without an error", async () => {
    const t = setup({ suggest: false, pick: false, results: [{ canceled: true, target: "claude", message: "已取消選擇工作資料夾" }] });
    await toFolder(t);
    expect(t.flow.getState().folder.view).toBe("native");
    const running = t.flow.connect();
    expect(t.flow.getState().nativePicker).toBe(true);
    await running;
    expect(t.calls[0].request?.workspaceToken).toBeUndefined();
    expect(t.flow.getState().screen).toBe("folder");
    expect(t.flow.getState().problem).toBeUndefined();
  });
});

describe("the ending: 連好了！ or a problem in plain words", () => {
  it("success: the sentence names the folder; the copy is that sentence plus the full editing rules; 換資料夾 goes back to step 2", async () => {
    const t = setup();
    await connectSuggested(t);
    expect(t.flow.getState().screen).toBe("success");
    expect(t.onConnected).toHaveBeenCalledOnce();
    expect(t.flow.starterRequest()).toBe("用 Editkin 把『Editkin 作品』資料夾裡的影片剪成一支 30 秒短片");
    await t.flow.copy("starter");
    expect(t.copied[0]).toBe("用 Editkin 把『Editkin 作品』資料夾裡的影片剪成一支 30 秒短片\n\n完整剪輯規則");
    t.flow.changeFolder(); await flush();
    expect(t.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose" } });
  });
  it("success without a starter prompt uses the contract's; Music MV mode keeps its route", async () => {
    const t = setup({ suggest: false, pick: false, musicMvMode: true, results: [{ ...OK, starterPrompt: undefined, workspace: "D:\\MV\\Song" }] });
    await toFolder(t);
    await t.flow.connect();
    expect(t.flow.starterRequest()).toBe("用 Editkin 把『Song』資料夾裡的素材做成一支原創插畫 Music MV");
    await t.flow.copy("starter");
    expect(t.copied[0].startsWith(`用 Editkin 把『Song』資料夾裡的素材做成一支原創插畫 Music MV\n\n${EDITKIN_AGENT_STARTER_PROMPT}\n\n本次請製作原創插畫動畫 Music MV`)).toBe(true);
  });
  it("success with the Video Autopilot skill missing offers it as optional; 看怎麼裝 opens the Kit page", async () => {
    const t = setup({ results: [{ ...OK, vaSkill: { installed: false, required: false, kitUrl: AGENT_KIT_URL_V1 } }] });
    await connectSuggested(t);
    expect(t.flow.getState().result?.vaSkill?.installed).toBe(false);
    await t.flow.openKit();
    expect(t.bridge.openUrl).toHaveBeenCalledWith(AGENT_KIT_URL_V1);
  });
  it("a repeat connect that finds it already there, or replaces an old entry, is a success", async () => {
    for (const result of [{ ...OK, status: "already_installed" as const, configChange: "unchanged" as const }, { ...OK, configChange: "replaced" as const, replacedExisting: true }]) {
      const t = setup({ results: [result] });
      await connectSuggested(t);
      expect(t.flow.getState().screen).toBe("success");
      expect(t.flow.getState().result?.configChange).toBe(result.configChange);
    }
  });
  for (const code of AGENT_SETUP_FAILURE_CODES_V1) {
    it(`${code}: a plain problem at its step; 再試一次 runs the setup again with a fresh folder token`, async () => {
      const t = setup({ results: [failed(code), OK] });
      await connectSuggested(t);
      const state = t.flow.getState();
      expect(state.screen).toBe("problem");
      expect(state.problem).toMatchObject({ code, step: STEP_OF[code], detail: `native detail for ${code}` });
      const stage = STEP_OF[code] === "write_config" ? "config" : STEP_OF[code] === "health_check" ? "hello" : "helper";
      // A problem found before connecting started (detect) marks no step; the others mark where it stopped.
      if (STEP_OF[code] === "detect") expect(state.stages).toEqual({ helper: "waiting", config: "waiting", hello: "waiting" });
      else expect(state.stages[stage]).toBe("failed");
      expect(AGENT_CONNECT_PROBLEM_COPY_V1[code].title).toBeTruthy();
      await t.flow.retry();
      expect(t.connect).toHaveBeenCalledTimes(2);
      expect(t.calls.map(call => call.request?.workspaceToken)).toEqual(["suggest-1", "suggest-2"]);
      expect(t.flow.getState().screen).toBe("success");
    });
  }
  it("再試一次 after a picked folder opens the picker at that folder for a fresh token; closing it stays on the problem", async () => {
    const t = setup({ results: [failed("HEALTH_CHECK_FAILED"), OK] });
    await toFolder(t);
    await t.flow.pickFolder();
    await t.flow.connect();
    (t.bridge.pickWorkspace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: true });
    await t.flow.retry();
    expect(t.bridge.pickWorkspace).toHaveBeenLastCalledWith("D:\\Videos\\Trip");
    expect(t.flow.getState().screen).toBe("problem");
    await t.flow.retry();
    expect(t.calls.map(call => call.request?.workspaceToken)).toEqual(["pick-1", "pick-2"]);
    expect(t.flow.getState().screen).toBe("success");
  });
  it("an expired or unsafe folder leads back to choosing the folder; an entry Editkin cannot replace leads to 我自己貼指令", async () => {
    for (const code of ["WORKSPACE_CHOICE_EXPIRED", "WORKSPACE_UNSAFE", "WORKSPACE_NOT_WRITABLE"] as const) {
      const t = setup({ results: [failed(code)] });
      await connectSuggested(t);
      expect(agentConnectPrimaryV1(t.flow.getState().problem!)).toBe("folder");
      t.flow.changeFolder(); await flush();
      expect(t.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose" } });
    }
    const exists = setup({ results: [failed("CONFIG_ALREADY_EXISTS_DIFFERENT")] });
    await connectSuggested(exists);
    expect(agentConnectPrimaryV1(exists.flow.getState().problem!)).toBe("manual");
    expect(agentConnectPrimaryV1({ ...exists.flow.getState().problem!, fallbackCommand: undefined })).toBe("retry");
  });
  it("我自己貼指令 copies exactly the fallback text from the result (the generated cmd script line)", async () => {
    const t = setup({ results: [failed("CONFIG_WRITE_REFUSED")] });
    await connectSuggested(t);
    expect(t.flow.getState().manualOpen).toBe(false);
    t.flow.toggleManual();
    await t.flow.copy("fallback");
    expect(t.copied).toEqual([CMD]);
  });
  it("a verified clipboard copy (status command_copied) opens 我自己貼指令 straight away", async () => {
    const t = setup({ results: [failed("CONFIG_WRITE_REFUSED", { status: "command_copied", health: "manual_step", clipboardWritten: true })] });
    await connectSuggested(t);
    expect(t.flow.getState()).toMatchObject({ screen: "problem", manualOpen: true, problem: { code: "CONFIG_WRITE_REFUSED", commandAlreadyCopied: true, fallbackCommand: CMD } });
  });
  it("複製問題報告 carries the code, step, detail, log path, Editkin version and the AI app (no work folder)", async () => {
    const t = setup({ results: [failed("HEALTH_CHECK_FAILED")] });
    await connectSuggested(t);
    await t.flow.copy("report");
    expect(t.copied[0]).toBe([
      "Editkin AI connection problem report",
      "Editkin: 0.15.0 (official, build 1a2b3c4d5e)",
      "AI app: Claude Code",
      "Code: HEALTH_CHECK_FAILED",
      "Step: health_check",
      "Status: failed",
      "Detail: native detail for HEALTH_CHECK_FAILED",
      "Log: %USERPROFILE%\\AppData\\Roaming\\studio.hao.editkin\\logs\\agent-connect.log",
      "Time: 2026-10-29T08:00:00.000Z",
    ].join("\n"));
    expect(t.copied[0]).not.toContain(DOCS);
  });
  it("the page buttons: download for a missing app, the Editkin page for missing files", async () => {
    const missing = setup({ results: [failed("AGENT_APP_NOT_FOUND")] });
    await connectSuggested(missing);
    await missing.flow.fix("download");
    expect(missing.bridge.openUrl).toHaveBeenCalledWith(AGENT_DOWNLOAD_URL_V1.claude);
    const files = setup({ results: [failed("RUNTIME_FILES_MISSING")] });
    await connectSuggested(files);
    await files.flow.fix("update");
    expect(files.bridge.openUrl).toHaveBeenCalledWith(EDITKIN_RELEASES_URL_V1);
  });
  it("a rejected setup keeps its real text under 查看原因 (never a generic line)", async () => {
    const t = setup({ results: [new Error("Claude Code CLI 尚未安裝或不在 PATH")] });
    await connectSuggested(t);
    expect(t.flow.getState().problem).toMatchObject({ code: "AGENT_APP_NOT_FOUND", step: "detect" });
    expect(t.flow.getState().problem?.detail).toContain("CLI 尚未安裝或不在 PATH");
  });
});

describe("older desktop results (no structured failure) still get plain words", () => {
  it("maps the Kit, the missing app, the folder, a copied command and the health check", () => {
    expect(agentConnectProblemV1({ canceled: false, target: "codex", status: "failed", health: "failed", cause: "kit_missing", detail: "找不到最新版 video-autopilot SKILL.md" }))
      .toMatchObject({ code: "KIT_MISSING", step: "detect", detail: "找不到最新版 video-autopilot SKILL.md" });
    expect(agentConnectProblemV1({ canceled: false, target: "codex", status: "failed", health: "failed", cause: "cli_missing" }).code).toBe("AGENT_APP_NOT_FOUND");
    expect(agentConnectProblemV1({ canceled: false, target: "codex", status: "failed", health: "failed", cause: "workspace", message: "無法確認所選工作資料夾" }).code).toBe("WORKSPACE_NOT_WRITABLE");
    expect(agentConnectProblemV1({ canceled: false, target: "claude", status: "command_copied", health: "manual_step", runtimeVerified: true }))
      .toMatchObject({ code: "MANUAL_STEP", commandAlreadyCopied: true, fallbackCommand: undefined });
    expect(agentConnectProblemV1({ canceled: false, target: "claude", status: "failed", health: "failed", runtimeVerified: true, message: "已收到設定，但健康檢查未通過" }).code).toBe("HEALTH_CHECK_FAILED");
    expect(agentConnectProblemV1({ canceled: false, target: "claude", status: "failed", health: "failed", message: "x" }).code).toBe("UNKNOWN");
  });
  it("a copied command from an older desktop (status command_copied, no text) opens 我自己貼指令 straight away", async () => {
    const t = setup({ suggest: false, pick: false, results: [{ canceled: false, target: "claude", status: "command_copied", health: "manual_step", runtimeVerified: true, message: "沒有接受自動設定" }] });
    await toFolder(t);
    await t.flow.connect();
    expect(t.flow.getState()).toMatchObject({ screen: "problem", manualOpen: true, problem: { code: "MANUAL_STEP" } });
  });
  it("the report says unknown when the build did not say its version", () => {
    expect(agentProblemReportV1({ problem: { code: "UNKNOWN", commandAlreadyCopied: false }, at: new Date(0) }))
      .toContain("Editkin: unknown\nAI app: unknown\nCode: UNKNOWN\nStep: unknown");
  });
});
