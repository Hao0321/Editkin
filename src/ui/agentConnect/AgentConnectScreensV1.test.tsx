import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interfacePreferences } from "../i18n/interfacePreferences";
import { AGENT_DOWNLOAD_URL_V1, EDITKIN_RELEASES_URL_V1 } from "./agentConnectCopyV1";
import { createAgentConnectFlowV1 } from "./agentConnectFlowV1";
import { AgentConnectScreen } from "./AgentConnectScreensV1";
import { AgentHelpButton, AgentHelpCard } from "./AgentHelpEntryV1";
import {
  AGENT_SETUP_FAILURE_CODES_V1, type AgentConnectBridgeV1, type AgentConnectRequestV1, type AgentDetectionV1, type AgentSetupFailureCodeV1, type AgentSetupResultV1, type AgentWorkspacePickV1,
} from "./agentConnectTypesV1";

// 2026-10-29 「讓 AI 幫我剪片」: the real screens rendered to static markup (zh-TW and English), and their buttons pressed
// through the element tree (the screens are hook-free). Real layout at 80–200% is in
// .rd/benchmarks/agent-connect-fix-20261029/ui/.
afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const DOCS = "C:\\Users\\Ama\\Documents\\Editkin 作品";
const OK: AgentSetupResultV1 = { canceled: false, target: "claude", status: "installed", health: "connected", runtimeVerified: true, runtimeToolCount: 104,
  starterPrompt: "完整剪輯規則", workspace: DOCS, clientRestartRequired: true, vaSkill: { installed: true }, configChange: "added",
  message: "Claude Code 已連上最新版 Editkin MCP。", verification: "已真實啟動最新 v3 generation launcher（104 tools）" };
const CMD = "cmd /d /c call \"%LOCALAPPDATA%\\Editkin\\agent-connect\\Connect Editkin to Claude Code.cmd\" --no-pause";
const failure = (code: AgentSetupFailureCodeV1): AgentSetupResultV1 => ({ canceled: false, target: "claude", status: "failed", health: "failed",
  failure: { step: code === "HEALTH_CHECK_FAILED" ? "health_check" : code.startsWith("CONFIG") ? "write_config" : code.startsWith("WORKSPACE") ? "detect" : "probe", code,
    detail: `native detail ${code}`, logPath: "C:\\logs\\agent-connect.log" }, fallbackCommand: CMD });

type Element = ReactElement<Record<string, any>>;
function expand(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => ReactNode)(element.props));
  return [element, ...expand(element.props.children)];
}
const byTestId = (tree: Element[], id: string) => tree.find(element => element.props["data-testid"] === id);

function make(options: { installed?: AgentDetectionV1; results?: AgentSetupResultV1[]; openUrl?: boolean; remembered?: boolean; picks?: AgentWorkspacePickV1[] } = {}) {
  const results = [...(options.results ?? [OK])];
  const picks = [...(options.picks ?? [])];
  let tokens = 0;
  const bridge: AgentConnectBridgeV1 = {
    detect: vi.fn(async () => options.installed ?? { claude: true, codex: false }),
    openUrl: options.openUrl === false ? undefined : vi.fn(async () => undefined),
    suggestWorkspace: vi.fn(async () => ({ token: `suggest-${++tokens}`, displayName: "Editkin 作品", displayPath: DOCS, exists: false, remembered: options.remembered === true })),
    pickWorkspace: vi.fn(async () => picks.length ? picks.shift()! : { canceled: false as const, token: `pick-${++tokens}`, displayName: "Trip", displayPath: "D:\\Videos\\Trip" }),
    buildInfo: vi.fn(async () => ({ version: "0.15.0" })),
    copyText: vi.fn(async () => true),
  };
  const connect = vi.fn(async (_target: "claude" | "codex", _request?: AgentConnectRequestV1) => results.length > 1 ? results.shift() : results[0]);
  const flow = createAgentConnectFlowV1({ bridge, connect });
  const onClose = vi.fn();
  const view = () => <AgentConnectScreen state={flow.getState()} flow={flow} onClose={onClose} />;
  return { flow, bridge, connect, onClose, html: () => renderToStaticMarkup(view()), tree: () => expand(view()) };
}
async function at(screen: "pick" | "folder" | "result", options: Parameters<typeof make>[0] = {}) {
  const t = make(options);
  t.flow.start(); await flush();
  if (screen === "pick") return t;
  t.flow.next(); await flush();
  if (screen === "folder") return t;
  await t.flow.useSuggestion();
  await t.flow.connect();
  return t;
}
/** What is on screen without opening anything: no folded details, no command box. */
const visible = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ");
const JARGON = /\b(MCP|JSON|scope|launcher|generation)\b/i;

describe("step 1 · pick the AI", () => {
  it("one app found: 「找到 Claude Code 了」, it is chosen, Codex says 還沒安裝 with a real download button and its address in small text", async () => {
    const t = await at("pick");
    const html = t.html();
    expect(html).toContain(">找到 Claude Code 了</h2>");
    expect(html).toMatch(/data-testid="agent-connect-app-claude"[\s\S]*?checked=""[\s\S]*?已安裝/);
    expect(html).toMatch(/data-testid="agent-connect-app-codex"[\s\S]*?還沒安裝[\s\S]*?<button type="button" class="easy-secondary agent-easy-page-button" data-testid="agent-connect-download-codex">[\s\S]*?下載 Codex/);
    expect(html).toMatch(/<small class="agent-easy-url" data-testid="agent-connect-download-codex-url">.*?<\/small>/);
    expect(html.match(/<small class="agent-easy-url" data-testid="agent-connect-download-codex-url">(.*?)<\/small>/)![1].replace(/<[^>]+>/g, "")).toBe(AGENT_DOWNLOAD_URL_V1.codex);
    expect(html).toContain("第 1 步，共 3 步");
    expect((html.match(/class="easy-primary"/g) ?? []).length).toBe(1);
    byTestId(t.tree(), "agent-connect-next")!.props.onClick();
    await flush();
    expect(t.flow.getState().screen).toBe("folder");
    expect(JARGON.test(visible(html))).toBe(false);
  });
  it("none found: 「電腦裡還沒有 AI 助手」, a download button per app that opens its official page, and 裝好了，再找一次", async () => {
    const t = await at("pick", { installed: { claude: false, codex: false } });
    let html = t.html();
    expect(html).toContain(">電腦裡還沒有 AI 助手</h2>");
    expect(html).toContain("下載 Claude Code");
    expect(html).toContain("下載 Codex");
    expect(html).toContain("裝好了，再找一次");
    expect(html).not.toContain("agent-connect-next");
    byTestId(t.tree(), "agent-connect-download-claude")!.props.onClick();
    await flush();
    expect(t.bridge.openUrl).toHaveBeenCalledWith(AGENT_DOWNLOAD_URL_V1.claude);
    html = t.html();
    expect(html).toContain("已經在瀏覽器打開 Claude Code 的下載頁。");
    byTestId(t.tree(), "agent-connect-detect-again")!.props.onClick();
    await flush();
    expect(t.bridge.detect).toHaveBeenCalledTimes(2);
  });
  it("when the browser cannot be opened: the address with 複製網址", async () => {
    const t = await at("pick", { installed: { claude: false, codex: false }, openUrl: false });
    byTestId(t.tree(), "agent-connect-download-codex")!.props.onClick();
    await flush();
    const html = t.html();
    expect(html).toContain("沒辦法自動打開瀏覽器。把這個網址貼到瀏覽器打開：");
    expect(html).toContain(`<code class="agent-easy-code">${AGENT_DOWNLOAD_URL_V1.codex}</code>`);
    expect(html).toContain("複製網址");
  });
  it("both found: 「要用哪一個 AI？」 with two choices, Claude Code chosen, Codex selectable", async () => {
    const t = await at("pick", { installed: { claude: true, codex: true } });
    const html = t.html();
    expect(html).toContain(">要用哪一個 AI？</h2>");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    byTestId(t.tree(), "agent-connect-choose-codex")!.props.onChange();
    expect(t.flow.getState().target).toBe("codex");
  });
  it("after an update whose refresh failed: 「Editkin 更新後要重新連一次 AI」 with one big 重新連一次", async () => {
    const t = await at("pick", { installed: { claude: true, codex: false, repair: { state: "failed" } }, remembered: true });
    const html = t.html();
    expect(html).toContain(">Editkin 更新後要重新連一次 AI</h2>");
    expect(html).toContain("按「重新連一次」就好，你的作品都還在。");
    expect(html).toMatch(/class="easy-primary" data-testid="agent-connect-reconnect"[\s\S]*?重新連一次/);
    expect(html).not.toContain("agent-connect-next");
    byTestId(t.tree(), "agent-connect-reconnect")!.props.onClick();
    await flush();
    expect(t.connect).toHaveBeenCalledOnce();
    expect(t.flow.getState().screen).toBe("success");
  });
  it("the entry card and the top bar button say the same when a reconnect is needed", () => {
    const card = renderToStaticMarkup(<AgentHelpCard onClick={() => undefined} repairNeeded />);
    expect(card).toContain("<strong>Editkin 更新後要重新連一次 AI</strong>");
    expect(card).toContain('<span class="agent-help-card-action">重新連一次</span>');
    expect(renderToStaticMarkup(<AgentHelpCard onClick={() => undefined} />)).toContain("<strong>讓 AI 幫我剪片</strong>");
    expect(renderToStaticMarkup(<AgentHelpButton onClick={() => undefined} repairNeeded />)).toMatch(/data-repair="true"[\s\S]*title="Editkin 更新後要重新連一次 AI"[\s\S]*<span>重新連一次 AI<\/span>/);
  });
});

describe("step 2 · the work folder (Hao: the creator names it)", () => {
  it("two equal, big choices: 選我放影片的資料夾 and 還沒有資料夾？幫我建一個 (with where it would go)", async () => {
    const t = await at("folder");
    const html = t.html();
    expect(html).toContain(">AI 要用哪個資料夾？</h2>");
    expect(html).toContain("AI 只會在這個資料夾裡看影片、存成品。");
    expect(html).toMatch(/<button type="button" class="agent-easy-option" data-testid="agent-connect-pick-folder">[\s\S]*?選我放影片的資料夾/);
    expect(html).toMatch(/<button type="button" class="agent-easy-option" data-testid="agent-connect-make-folder">[\s\S]*?還沒有資料夾？幫我建一個[\s\S]*?會建在：<span class="agent-easy-path"><span>C:\\<wbr\/><\/span><span>Users\\<wbr\/><\/span><span>Ama\\<wbr\/><\/span><span>Documents\\<wbr\/><\/span><span>Editkin 作品<\/span><\/span>/);
    expect(html).not.toContain('class="easy-primary"'); // neither choice outranks the other
    expect(html).toContain("第 2 步，共 3 步");
    expect(JARGON.test(visible(html))).toBe(false);
  });
  it("the picked folder is shown for confirmation, then 用這個資料夾; 換一個資料夾 goes back to the choices", async () => {
    const t = await at("folder");
    byTestId(t.tree(), "agent-connect-pick-folder")!.props.onClick();
    await flush();
    const html = t.html();
    expect(html).toContain("<strong>Trip</strong>");
    expect(html).toContain("<span>Videos\\<wbr/></span><span>Trip</span>"); // the path wraps only after a separator
    expect(html).toMatch(/class="easy-primary" data-testid="agent-connect-use-folder"/);
    byTestId(t.tree(), "agent-connect-change-folder")!.props.onClick();
    expect(t.flow.getState().folder.view).toBe("choose");
    byTestId(t.tree(), "agent-connect-back")!.props.onClick();
    expect(t.flow.getState().screen).toBe("pick");
  });
  it("the remembered folder is labelled 上次用的; a new one says it is made only when used", async () => {
    const remembered = await at("folder", { remembered: true });
    expect(remembered.html()).toContain("上次用的：Editkin 作品");
    await remembered.flow.useSuggestion();
    expect(remembered.html()).toMatch(/<span class="agent-easy-badge">上次用的<\/span>/);
    const fresh = await at("folder");
    await fresh.flow.useSuggestion();
    expect(fresh.html()).toContain("按「用這個資料夾」後才會建立它。");
    expect(fresh.html()).toMatch(/<span class="agent-easy-badge">建議<\/span>/);
  });
  it("a refused folder shows the plain message and the folder, and stays on step 2", async () => {
    const t = await at("folder", { picks: [{ canceled: false, refused: true, code: "WORKSPACE_UNSAFE", message: "磁碟根目錄不能用", displayName: "C:", displayPath: "C:\\" }] });
    await t.flow.pickFolder();
    const html = t.html();
    expect(html).toContain("這個資料夾不能用，請選一般的資料夾，例如「文件」裡的。");
    expect(html).toMatch(/data-testid="agent-connect-folder-refused"[\s\S]*<span>C:\\<\/span>/);
    expect(t.flow.getState().screen).toBe("folder");
  });
});

describe("step 3 · connecting", () => {
  it("three friendly steps, marked live as the native side reports them", async () => {
    const t = await at("folder");
    await t.flow.useSuggestion();
    let release!: (value: AgentSetupResultV1) => void;
    let progress!: (event: { step: "prepare_runtime" | "write_config" | "health_check"; state: "running" | "done" | "failed" }) => void;
    t.connect.mockImplementationOnce((_target, request) => { progress = request!.onProgress!; return new Promise(resolve => { release = resolve; }); });
    byTestId(t.tree(), "agent-connect-use-folder")!.props.onClick();
    let html = t.html();
    expect(html).toContain(">正在連接 Claude Code…</h2>");
    expect(html).toMatch(/data-status="current" data-stage="helper"[\s\S]*準備小幫手/);
    progress({ step: "prepare_runtime", state: "done" });
    progress({ step: "write_config", state: "running" });
    html = t.html();
    expect(html).toMatch(/data-status="done" data-stage="helper"/);
    expect(html).toMatch(/data-status="current" data-stage="config"[\s\S]*告訴 Claude Code 怎麼找到 Editkin/);
    expect(html).toMatch(/data-status="waiting" data-stage="hello"[\s\S]*試著打招呼/);
    expect(JARGON.test(visible(html))).toBe(false);
    release(OK); await flush();
    expect(t.flow.getState().screen).toBe("success");
  });
});

describe("the ending", () => {
  it("連好了！ with the sentence to paste, a big copy button, how to open Claude Code, the folder and 換資料夾", async () => {
    const t = await at("result");
    const html = t.html();
    expect(html).toContain(">連好了！</h2>");
    expect(html).toContain("最後一步：打開 Claude Code，把這句話貼上去");
    expect(html).toContain("用 Editkin 把『Editkin 作品』資料夾裡的影片剪成一支 30 秒短片");
    expect(html).toMatch(/class="easy-primary" data-testid="copy-agent-starter-prompt"[^>]*>[\s\S]*?複製這句話/);
    expect(html).toMatch(/<summary>怎麼打開 Claude Code？<\/summary><ol><li>按鍵盤的 Windows 鍵，輸入 PowerShell，按 Enter。<\/li><li>在跳出來的視窗輸入 claude，按 Enter。<\/li>/);
    expect(html).toContain("AI 用的資料夾：Editkin 作品");
    expect(html).not.toContain("agent-connect-va-optional");
    expect(html).not.toContain("已把舊的 Editkin 設定換成這一版");
    expect(JARGON.test(visible(html))).toBe(false);
    byTestId(t.tree(), "copy-agent-starter-prompt")!.props.onClick();
    await flush();
    expect(t.bridge.copyText).toHaveBeenCalledWith("用 Editkin 把『Editkin 作品』資料夾裡的影片剪成一支 30 秒短片\n\n完整剪輯規則");
    expect(t.html()).toContain("已複製，去貼上吧");
    byTestId(t.tree(), "agent-connect-success-change-folder")!.props.onClick();
    await flush();
    expect(t.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose" } });
  });
  it("an old entry replaced: one small line says so", async () => {
    const t = await at("result", { results: [{ ...OK, configChange: "replaced", replacedExisting: true }] });
    expect(t.html()).toContain('<p class="easy-muted" data-testid="agent-connect-replaced">已把舊的 Editkin 設定換成這一版</p>');
  });
  it("without the Video Autopilot skill: an optional, clearly secondary card", async () => {
    const t = await at("result", { results: [{ ...OK, vaSkill: { installed: false, required: false } }] });
    const html = t.html();
    expect(html).toContain("想剪得更好？可以再裝「影片自動剪輯技能」（選用）");
    expect(html).toMatch(/data-testid="agent-connect-va-optional"[\s\S]*class="easy-link"/);
    expect((html.match(/class="easy-primary"/g) ?? []).length).toBe(1);
  });
  const PRIMARY: Partial<Record<AgentSetupFailureCodeV1, string>> = {
    WORKSPACE_NOT_WRITABLE: "換一個資料夾", WORKSPACE_CHOICE_EXPIRED: "再選一次資料夾", WORKSPACE_UNSAFE: "換一個資料夾", CONFIG_ALREADY_EXISTS_DIFFERENT: "我自己貼指令",
  };
  for (const code of AGENT_SETUP_FAILURE_CODES_V1) {
    it(`${code}: its own title and sentence, its main button, 再試一次, 我自己貼指令, 複製問題報告 and the reason folded`, async () => {
      const t = await at("result", { results: [failure(code), OK] });
      const html = t.html();
      expect(html).not.toContain("這次沒有連成功");
      expect(html).toMatch(new RegExp(`class="easy-primary"[^>]*>[\\s\\S]*?<span>${PRIMARY[code] ?? "再試一次"}</span>`));
      expect(html).toContain(">再試一次</span>");
      expect(html).toContain("我自己貼指令");
      expect(html).toContain("複製問題報告");
      expect(html).toMatch(new RegExp(`<summary>查看原因</summary><p>native detail ${code}</p><p>紀錄檔：C:\\\\logs\\\\agent-connect.log</p>`));
      expect(html).not.toContain("Connect Editkin to Claude Code.cmd"); // the command shows only after 我自己貼指令
      expect(JARGON.test(visible(html))).toBe(false);
      byTestId(t.tree(), "agent-connect-manual")!.props.onClick();
      const open = t.html();
      expect(open).toContain(">自己貼一次指令</h3>");
      expect(open).toContain('<pre class="agent-easy-code agent-easy-command" data-testid="agent-connect-fallback-command" data-authored-content="agent-command">cmd /d /c call &quot;%LOCALAPPDATA%\\Editkin\\agent-connect\\Connect Editkin to Claude Code.cmd&quot; --no-pause</pre>');
      expect(open).toMatch(/<li>按鍵盤的 Windows 鍵<\/li><li>輸入 PowerShell（用「命令提示字元」也可以）<\/li><li>按 Enter<\/li><li>按 Ctrl\+V 貼上<\/li><li>再按一次 Enter<\/li>/);
      byTestId(t.tree(), "agent-connect-retry")!.props.onClick();
      await flush();
      expect(t.connect).toHaveBeenCalledTimes(2);
      expect(t.flow.getState().screen).toBe("success");
    });
  }
  it("the per-code titles people see", async () => {
    const titles: Record<AgentSetupFailureCodeV1, string> = {
      AGENT_APP_NOT_FOUND: "找不到 Claude Code", RUNTIME_FILES_MISSING: "Editkin 的連線小幫手沒有啟動", RUNTIME_PROBE_FAILED: "Editkin 的連線小幫手沒有啟動",
      WORKSPACE_NOT_WRITABLE: "這個資料夾不能用", WORKSPACE_CHOICE_EXPIRED: "請再選一次資料夾", WORKSPACE_UNSAFE: "這個資料夾不能用",
      CONFIG_WRITE_REFUSED: "Claude Code 沒有讓 Editkin 寫入設定", CONFIG_ALREADY_EXISTS_DIFFERENT: "Claude Code 裡有一份 Editkin 設定，Editkin 沒辦法自己換掉",
      HEALTH_CHECK_FAILED: "設定寫好了，但打招呼沒有回應", UNKNOWN: "這次沒連上",
    };
    for (const code of AGENT_SETUP_FAILURE_CODES_V1) {
      const t = await at("result", { results: [failure(code)] });
      expect(t.html(), code).toContain(`>${titles[code]}</h2>`);
    }
    const missing = await at("result", { results: [failure("AGENT_APP_NOT_FOUND")] });
    expect(missing.html()).toMatch(/data-testid="agent-connect-fix-download"[\s\S]*?下載 Claude Code/);
    expect(missing.html().replace(/<[^>]+>/g, "")).toContain("https://code.claude.com/docs/en/setup");
    const helper = await at("result", { results: [failure("RUNTIME_PROBE_FAILED")] });
    expect(helper.html()).toContain("請更新 Editkin");
    expect(helper.html().replace(/<[^>]+>/g, "")).toContain(EDITKIN_RELEASES_URL_V1);
    const unsafe = await at("result", { results: [failure("WORKSPACE_UNSAFE")] });
    expect(unsafe.html()).toContain("請選一般的資料夾，例如「文件」裡的。");
    byTestId(unsafe.tree(), "agent-connect-choose-folder-again")!.props.onClick();
    await flush();
    expect(unsafe.flow.getState()).toMatchObject({ screen: "folder", folder: { view: "choose" } });
  });
  it("an older desktop's copied command: the paste steps open at once with 貼好了，再檢查一次", async () => {
    const t = make({ results: [{ canceled: false, target: "claude", status: "command_copied", health: "manual_step", runtimeVerified: true }] });
    t.flow.start(); await flush(); t.flow.next(); await flush();
    await t.flow.useSuggestion(); await t.flow.connect();
    const html = t.html();
    expect(html).toContain(">還差一步：自己貼一次指令</h2>");
    expect(html).toContain("指令已經複製好了。");
    expect(html).toContain("貼好了，再檢查一次");
    expect(html).toContain("<li>輸入 PowerShell（用「命令提示字元」也可以）</li>");
  });
});

describe("the same screens in English", () => {
  it("pick, folder, success and a problem read in English", async () => {
    await interfacePreferences.setLocale("en");
    const pick = await at("pick");
    expect(pick.html()).toContain(">Found Claude Code</h2>");
    expect(pick.html()).toContain("Not installed yet");
    expect(pick.html()).toContain("Download Codex");
    const folder = await at("folder");
    expect(folder.html()).toContain("The AI only looks at videos and saves finished work inside this folder.");
    expect(folder.html()).toContain("Choose the folder with my videos");
    expect(folder.html()).toContain("No folder yet? Make one for me");
    const done = await at("result", { results: [{ ...OK, configChange: "replaced" }] });
    expect(done.html()).toContain(">Connected!</h2>");
    expect(done.html()).toContain("Use Editkin to edit the videos in the “Editkin 作品” folder into one 30-second short");
    expect(done.html()).toContain("The old Editkin setting was replaced with this version");
    expect(done.html()).toContain("Change folder");
    const problem = await at("result", { results: [failure("CONFIG_ALREADY_EXISTS_DIFFERENT")] });
    const html = problem.html();
    expect(html).toContain(">Claude Code has an Editkin setting that Editkin can&#x27;t replace on its own</h2>");
    expect(html).toContain("I&#x27;ll paste the command myself");
    expect(html).toContain("Try again");
    expect(html).toContain("Copy problem report");
    const repair = await at("pick", { installed: { claude: true, codex: false, repair: { state: "failed" } } });
    expect(repair.html()).toContain(">After the Editkin update, connect your AI once more</h2>");
    for (const text of [pick.html(), folder.html(), done.html(), html, repair.html()]) expect(visible(text)).not.toMatch(/[\u3400-\u9fff]{2,}(?<!作品)/);
  }, 180_000);
  it("every problem title and sentence has a translation in all four other languages", async () => {
    const { AGENT_CONNECT_PROBLEM_COPY_V1, AGENT_CONNECT_STAGES_V1, AGENT_CONNECT_FIX_LABEL_V1, AGENT_STARTER_REQUEST_V1, AGENT_STARTER_REQUEST_NO_FOLDER_V1,
      AGENT_STARTER_REQUEST_MV_V1, AGENT_STARTER_REQUEST_MV_NO_FOLDER_V1 } = await import("./agentConnectCopyV1");
    const keys = [...Object.values(AGENT_CONNECT_PROBLEM_COPY_V1).flatMap(copy => [copy.title, copy.body]), ...AGENT_CONNECT_STAGES_V1.map(stage => stage.label),
      ...Object.values(AGENT_CONNECT_FIX_LABEL_V1), AGENT_STARTER_REQUEST_V1, AGENT_STARTER_REQUEST_NO_FOLDER_V1, AGENT_STARTER_REQUEST_MV_V1, AGENT_STARTER_REQUEST_MV_NO_FOLDER_V1];
    for (const locale of ["en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      for (const key of keys) expect(interfacePreferences.translate(key), `${locale}: ${key}`).not.toBe(key);
    }
  }, 180_000);
});
