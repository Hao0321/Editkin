import type { ReactNode, Ref } from "react";
import type { AgentTarget } from "../../application/agentSetup";
import { translateUi as uiText, translateUiStatus } from "../i18n/interfacePreferences";
import { EasyIcon, type EasyIconName } from "../easy/easyIcons";
import {
  AGENT_APP_NAME_V1, AGENT_COMMAND_V1, AGENT_CONNECT_FIX_LABEL_V1, AGENT_CONNECT_FIX_URL_V1, AGENT_CONNECT_PROBLEM_COPY_V1, AGENT_CONNECT_STAGES_V1,
  AGENT_DOWNLOAD_URL_V1, AGENT_KIT_URL_V1, AGENT_TARGETS_V1, agentConnectPrimaryV1,
} from "./agentConnectCopyV1";
import type { AgentConnectFlowV1, AgentConnectStateV1, AgentCopyKindV1, AgentStageStatusV1 } from "./agentConnectFlowV1";

/**
 * Pure screens of 「讓 AI 幫我剪片」: no hooks, no state. AgentConnectModal passes the flow's state, the flow itself
 * and the heading ref (focus moves to each step's heading). Big targets, plain words, one filled button per screen.
 */
export interface AgentConnectScreenPropsV1 {
  state: AgentConnectStateV1;
  flow: AgentConnectFlowV1;
  onClose: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

export const AGENT_CONNECT_TITLE_ID = "agent-connect-title";

function CopyIcon() {
  return <svg className="easy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></svg>;
}
function ExternalIcon() {
  return <svg className="easy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round"><path d="M14 4.5h5.5V10" /><path d="M19.5 4.5 11 13" /><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4" /></svg>;
}

type IconName = EasyIconName | "copy" | "external";
function Icon({ name }: { name: IconName }) {
  if (name === "copy") return <CopyIcon />;
  if (name === "external") return <ExternalIcon />;
  return <EasyIcon name={name} />;
}

function Primary(props: { icon: IconName; label: string; onClick: () => void; testId: string; disabled?: boolean; busy?: boolean; expanded?: boolean; controls?: string }) {
  return <button type="button" className="easy-primary" data-testid={props.testId} onClick={props.onClick} disabled={props.disabled || props.busy}
    aria-busy={props.busy || undefined} aria-expanded={props.expanded} aria-controls={props.controls}>
    {props.busy ? <span className="easy-spinner" aria-hidden="true" /> : <Icon name={props.icon} />}<span>{props.label}</span></button>;
}
function Secondary(props: { icon: IconName; label: string; onClick: () => void; testId: string; expanded?: boolean; controls?: string; busy?: boolean }) {
  return <button type="button" className="easy-secondary" data-testid={props.testId} onClick={props.onClick} disabled={props.busy} aria-busy={props.busy || undefined}
    aria-expanded={props.expanded} aria-controls={props.controls}>{props.busy ? <span className="easy-spinner" aria-hidden="true" /> : <Icon name={props.icon} />}<span>{props.label}</span></button>;
}
function LinkButton(props: { icon?: IconName; label: string; onClick: () => void; testId: string }) {
  return <button type="button" className="easy-link" data-testid={props.testId} onClick={props.onClick}>{props.icon && <Icon name={props.icon} />}<span>{props.label}</span></button>;
}

function Frame(props: { title: string; lead?: string; step?: number; onBack?: () => void; icon?: EasyIconName; tone?: "info" | "success" | "warning";
  headingRef?: Ref<HTMLHeadingElement>; screen: string; children?: ReactNode }) {
  return <div className="agent-easy-screen" data-agent-screen={props.screen}>
    {(props.onBack || props.step) && <div className="easy-topbar">
      {props.onBack ? <button type="button" className="easy-back" onClick={props.onBack} data-testid="agent-connect-back"><EasyIcon name="arrow-left" /><span>{uiText("上一步")}</span></button> : <span />}
      {props.step && <span className="easy-step">{uiText("第 {current} 步，共 {total} 步", { current: props.step, total: 3 })}</span>}
    </div>}
    {props.icon && <div className={`easy-hero-icon easy-tone-${props.tone ?? "info"}`}><EasyIcon name={props.icon} /></div>}
    <h2 id={AGENT_CONNECT_TITLE_ID} className="easy-title" tabIndex={-1} ref={props.headingRef}>{props.title}</h2>
    {props.lead && <p className="easy-lead" id="agent-connect-lead">{props.lead}</p>}
    {props.children}
  </div>;
}

function Copied({ state, kind, idle, done, icon = "copy", onClick, testId, primary }: { state: AgentConnectStateV1; kind: AgentCopyKindV1; idle: string; done: string;
  icon?: IconName; onClick: () => void; testId: string; primary?: boolean }) {
  const copied = state.copied?.kind === kind && state.copied.ok;
  const props = { icon: copied ? "check" as const : icon, label: copied ? done : idle, onClick, testId };
  return primary ? <Primary {...props} /> : <Secondary {...props} />;
}

function CopyFailed({ state, kind }: { state: AgentConnectStateV1; kind: AgentCopyKindV1 }) {
  if (state.copied?.kind !== kind || state.copied.ok) return null;
  return <p className="easy-error" role="alert" data-testid="agent-connect-copy-failed"><EasyIcon name="alert" /><span>{uiText("系統不允許自動複製，請在上方文字框手動選取。")}</span></p>;
}

/** A page button: opens the official page in the browser; its address stays under it in small text. */
function PageButton({ label, url, onClick, testId }: { label: string; url: string; onClick: () => void; testId: string }) {
  return <div className="agent-easy-page">
    <button type="button" className="easy-secondary agent-easy-page-button" data-testid={testId} onClick={onClick}><ExternalIcon /><span>{label}</span></button>
    <small className="agent-easy-url" data-testid={`${testId}-url`}><PathText path={url} /></small>
  </div>;
}

/** After a page button: the browser opened it, or (it could not) the address with 複製網址. */
function PageNotice({ state, flow, app }: { state: AgentConnectStateV1; flow: AgentConnectFlowV1; app: string }) {
  const page = state.page;
  if (!page) return null;
  if (page.opened) {
    const text = page.purpose === "kit" ? uiText("已經在瀏覽器打開「影片自動剪輯技能」的說明頁。")
      : page.purpose === "editkin" ? uiText("已經在瀏覽器打開 Editkin 的下載頁。")
        : uiText("已經在瀏覽器打開 {app} 的下載頁。裝好後回來按「裝好了，再找一次」。", { app: AGENT_APP_NAME_V1[page.purpose] ?? app });
    return <p className="easy-note" role="status" data-testid="agent-connect-page-opened"><EasyIcon name="info" /><span>{text}</span></p>;
  }
  return <div className="agent-easy-address" role="status" data-testid="agent-connect-page-address">
    <p>{uiText("沒辦法自動打開瀏覽器。把這個網址貼到瀏覽器打開：")}</p>
    <code className="agent-easy-code">{page.url}</code>
    <Copied state={state} kind="url" idle={uiText("複製網址")} done={uiText("網址已複製")} onClick={() => void flow.copy("url")} testId="agent-connect-copy-url" />
    <CopyFailed state={state} kind="url" />
  </div>;
}

function stageWords(status: AgentStageStatusV1): string {
  if (status === "done") return uiText("做好了");
  if (status === "running") return uiText("正在做");
  if (status === "failed") return uiText("沒有成功");
  return uiText("還沒開始");
}

function Stages({ state, app }: { state: AgentConnectStateV1; app: string }) {
  return <ol className="easy-steps agent-easy-stages" data-testid="agent-connect-stages">
    {AGENT_CONNECT_STAGES_V1.map(stage => {
      const status = state.stages[stage.id];
      return <li key={stage.id} data-status={status === "running" ? "current" : status} data-stage={stage.id}>
        <span className="easy-step-mark" aria-hidden="true">{status === "done" ? <EasyIcon name="check" /> : status === "running" ? <span className="easy-spinner" />
          : status === "failed" ? <EasyIcon name="alert" /> : <EasyIcon name="circle" />}</span>
        <span className="easy-step-label">{uiText(stage.label, { app })}</span>
        <span className="visually-hidden">{stageWords(status)}</span>
      </li>;
    })}
  </ol>;
}

/** A folder path or web address that may wrap after each separator (never in the middle of a name). */
function PathText({ path }: { path: string }) {
  const parts = path.split(/(?<=[\\/])/);
  return <>{parts.map((part, index) => <span key={index}>{part}{index < parts.length - 1 && <wbr />}</span>)}</>;
}

function AppMark({ target }: { target: AgentTarget }) {
  return <span className={`agent-easy-app-mark agent-easy-app-mark-${target}`} aria-hidden="true">{target === "claude" ? "◆" : "⌘"}</span>;
}

export function AgentPickScreen({ state, flow, headingRef }: AgentConnectScreenPropsV1) {
  const checking = state.detection === "checking";
  const known = state.detection === "done" && state.installed;
  const found = known ? AGENT_TARGETS_V1.filter(target => state.installed![target]) : [];
  const none = Boolean(known) && found.length === 0;
  // After an Editkin update the start-up refresh failed: one normal connect fixes it.
  const repair = !checking && !none && state.repair?.state === "failed";
  const title = checking ? uiText("正在找電腦裡的 AI…")
    : repair ? uiText("Editkin 更新後要重新連一次 AI")
      : none ? uiText("電腦裡還沒有 AI 助手")
        : found.length === 1 ? uiText("找到 {app} 了", { app: AGENT_APP_NAME_V1[found[0]] })
          : uiText("要用哪一個 AI？");
  const lead = checking ? undefined
    : repair ? found.length > 1 ? uiText("選你平常用的 AI，再按「重新連一次」。你的作品都還在。") : uiText("按「重新連一次」就好，你的作品都還在。")
      : none ? uiText("先裝一個，裝好再回來。兩個都可以，選一個就好。")
        : found.length === 1 ? uiText("按「下一步」，讓 {app} 學會用 Editkin。", { app: AGENT_APP_NAME_V1[found[0]] })
          : found.length > 1 ? uiText("兩個都找到了，選一個就好。")
            : uiText("選你電腦裡裝好的那一個。");
  const tile = (target: AgentTarget) => {
    const name = AGENT_APP_NAME_V1[target];
    const installed = known ? state.installed![target] : undefined;
    if (installed === false) return <div key={target} className="agent-easy-app" data-installed="false" data-testid={`agent-connect-app-${target}`}>
      <AppMark target={target} />
      <span className="agent-easy-app-text"><strong>{name}</strong><small className="agent-easy-app-status">{uiText("還沒安裝")}</small></span>
      <PageButton label={uiText("下載 {app}", { app: name })} url={AGENT_DOWNLOAD_URL_V1[target]} onClick={() => void flow.openDownload(target)}
        testId={`agent-connect-download-${target}`} />
    </div>;
    const selected = state.target === target;
    return <label key={target} className="easy-choice agent-easy-app" data-selected={selected} data-installed={installed === true ? "true" : "unknown"} data-testid={`agent-connect-app-${target}`}>
      <input className="easy-radio" type="radio" name="agent-connect-app" value={target} checked={selected} onChange={() => flow.choose(target)}
        data-testid={`agent-connect-choose-${target}`} />
      <AppMark target={target} />
      <span className="agent-easy-app-text"><strong>{name}</strong>
        {installed === true && <small className="agent-easy-app-status" data-installed="true"><EasyIcon name="check" />{uiText("已安裝")}</small>}</span>
      <span className="easy-check" aria-hidden="true"><EasyIcon name="check" /></span>
    </label>;
  };
  return <Frame title={title} lead={lead} step={1} headingRef={headingRef} screen="pick">
    {/* The heading changes when the search ends; this line says it out loud for screen readers. */}
    <p className="visually-hidden" role="status">{checking ? "" : title}</p>
    {checking ? <p className="agent-easy-status"><span className="easy-spinner" aria-hidden="true" /><span>{uiText("通常幾秒鐘就好。")}</span></p>
      : none ? <div className="agent-easy-apps" role="group" aria-label={uiText("下載 AI 助手")}>{AGENT_TARGETS_V1.map(tile)}</div>
        : <fieldset className="easy-choices agent-easy-apps">
          <legend className="visually-hidden">{uiText("選一個 AI")}</legend>
          {AGENT_TARGETS_V1.map(tile)}
        </fieldset>}
    <PageNotice state={state} flow={flow} app={flow.appName()} />
    {!checking && <div className="easy-cta">
      {none ? <Primary icon="refresh" label={uiText("裝好了，再找一次")} onClick={() => void flow.detectAgain()} testId="agent-connect-detect-again" />
        : repair ? <Primary icon="refresh" label={uiText("重新連一次")} onClick={() => void flow.reconnect()} testId="agent-connect-reconnect" disabled={!state.target} />
          : <Primary icon="arrow-right" label={uiText("下一步")} onClick={flow.next} testId="agent-connect-next" disabled={!state.target} />}
    </div>}
    {none && <p className="easy-muted">{uiText("還是找不到的話，把 Editkin 關掉再打開。")}</p>}
    {!checking && !none && !repair && found.length > 0 && found.length < AGENT_TARGETS_V1.length && <p className="easy-muted">{uiText("想用另一個 AI，可以先按它下面的下載按鈕裝好。")}</p>}
  </Frame>;
}

export function AgentFolderScreen({ state, flow, headingRef }: AgentConnectScreenPropsV1) {
  const folder = state.folder, choice = folder.choice, suggestion = folder.suggestion;
  const refused = folder.refused;
  const suggestionLine = suggestion ? suggestion.remembered ? uiText("上次用的：{folder}", { folder: suggestion.displayName })
      : <>{uiText("會建在：")}<span className="agent-easy-path"><PathText path={suggestion.displayPath} /></span></>
    : folder.suggestionState === "loading" ? uiText("正在準備建議的資料夾…") : uiText("會建在「文件」裡的「Editkin 作品」");
  return <Frame title={uiText("AI 要用哪個資料夾？")} lead={uiText("AI 只會在這個資料夾裡看影片、存成品。")} step={2} onBack={flow.back} headingRef={headingRef} screen="folder">
    {folder.view === "choose" && <>
      <div className="agent-easy-options" role="group" aria-label={uiText("選資料夾的方法")}>
        <button type="button" className="agent-easy-option" data-testid="agent-connect-pick-folder" onClick={() => void flow.pickFolder()}
          disabled={Boolean(folder.busy)} aria-busy={folder.busy === "pick" || undefined}>
          <span className="agent-easy-option-icon" aria-hidden="true">{folder.busy === "pick" ? <span className="easy-spinner" /> : <EasyIcon name="folder-open" />}</span>
          <span className="agent-easy-option-text"><strong>{uiText("選我放影片的資料夾")}</strong>
            <small>{folder.busy === "pick" ? uiText("請在跳出來的視窗裡選一個資料夾。") : uiText("電腦裡已經有放影片的資料夾，就選它。")}</small></span>
        </button>
        <button type="button" className="agent-easy-option" data-testid="agent-connect-make-folder" onClick={() => void flow.useSuggestion()}
          disabled={Boolean(folder.busy) || folder.suggestionState === "failed"} aria-busy={folder.busy === "suggest" || undefined}>
          <span className="agent-easy-option-icon" aria-hidden="true">{folder.busy === "suggest" ? <span className="easy-spinner" /> : <EasyIcon name="folder-plus" />}</span>
          <span className="agent-easy-option-text"><strong>{uiText("還沒有資料夾？幫我建一個")}</strong>
            <small>{suggestion?.remembered && <span className="agent-easy-badge">{uiText("上次用的")}</span>}{suggestionLine}</small></span>
        </button>
      </div>
      {refused && <div className="easy-alert" role="alert" data-testid="agent-connect-folder-refused"><EasyIcon name="alert" />
        <div><p>{refused.code === "WORKSPACE_UNSAFE" ? uiText("這個資料夾不能用，請選一般的資料夾，例如「文件」裡的。") : translateUiStatus(refused.message)}</p>
          <p className="agent-easy-path"><PathText path={refused.displayPath} /></p></div></div>}
    </>}
    {folder.view === "confirm" && choice && <>
      <div className="agent-easy-folder" data-testid="agent-connect-folder">
        <EasyIcon name="folder-open" />
        <span className="agent-easy-folder-text"><strong>{choice.displayName}</strong><small className="agent-easy-path"><PathText path={choice.displayPath} /></small></span>
        {choice.kind === "suggested" && <span className="agent-easy-badge">{choice.remembered ? uiText("上次用的") : uiText("建議")}</span>}
      </div>
      <p className="easy-note"><EasyIcon name="info" /><span>{choice.kind === "suggested" && choice.exists === false
        ? uiText("按「用這個資料夾」後才會建立它。之後把要剪的影片放進去就好。") : uiText("把要剪的影片放進這個資料夾就好。")}</span></p>
      <div className="easy-cta"><Primary icon="check" label={uiText("用這個資料夾")} onClick={() => void flow.connect()} testId="agent-connect-use-folder" /></div>
      <nav className="easy-links" aria-label={uiText("其他做法")}>
        <LinkButton icon="folder-open" label={uiText("換一個資料夾")} onClick={flow.chooseAgain} testId="agent-connect-change-folder" />
      </nav>
    </>}
    {folder.view === "native" && <>
      <p className="easy-note"><EasyIcon name="info" /><span>{uiText("按「選資料夾」後，會跳出一個視窗讓你選。把要剪的影片放進那個資料夾就好。")}</span></p>
      <div className="easy-cta"><Primary icon="folder-open" label={uiText("選資料夾")} onClick={() => void flow.connect()} testId="agent-connect-pick-folder" /></div>
    </>}
  </Frame>;
}

export function AgentConnectingScreen({ state, flow, headingRef }: AgentConnectScreenPropsV1) {
  const app = flow.appName();
  const running = AGENT_CONNECT_STAGES_V1.find(stage => state.stages[stage.id] === "running");
  return <Frame title={uiText("正在連接 {app}…", { app })} lead={uiText("通常不到一分鐘，不用一直看著。")} step={3} headingRef={headingRef} screen="connecting">
    {state.nativePicker && <p className="easy-hint" data-testid="agent-connect-native-picker"><EasyIcon name="folder-open" /><span>{uiText("請在跳出來的視窗裡選一個資料夾。")}</span></p>}
    <Stages state={state} app={app} />
    <p className="visually-hidden" role="status">{running ? uiText(running.label, { app }) : ""}</p>
  </Frame>;
}

export function AgentSuccessScreen({ state, flow, onClose, headingRef }: AgentConnectScreenPropsV1) {
  const result = state.result;
  const app = flow.appName();
  const target = state.target ?? result?.target ?? "claude";
  const already = result?.status === "already_installed" || result?.status === "already_configured";
  const restart = result?.clientRestartRequired !== false && !already;
  const folder = flow.folderName();
  return <Frame title={uiText("連好了！")} lead={already ? uiText("{app} 之前就連好了，不用再設定。", { app }) : uiText("{app} 現在認得 Editkin 了。", { app })}
    icon="check" tone="success" headingRef={headingRef} screen="success">
    {result?.configChange === "replaced" && <p className="easy-muted" data-testid="agent-connect-replaced">{uiText("已把舊的 Editkin 設定換成這一版")}</p>}
    <section className="agent-easy-paste" aria-labelledby="agent-easy-paste-title">
      <h3 id="agent-easy-paste-title">{uiText("最後一步：打開 {app}，把這句話貼上去", { app })}</h3>
      <p className="agent-easy-request" data-testid="agent-connect-request" data-authored-content="agent-instructions">{flow.starterRequest()}</p>
      <div className="easy-cta">
        <Copied state={state} kind="starter" idle={uiText("複製這句話")} done={uiText("已複製，去貼上吧")} onClick={() => void flow.copy("starter")}
          testId="copy-agent-starter-prompt" primary />
      </div>
      <CopyFailed state={state} kind="starter" />
      <p className="easy-muted">{uiText("複製時會一起附上給 AI 看的剪輯規則，貼上就好，不用改。")}</p>
    </section>
    <details className="agent-easy-howto" data-testid="agent-connect-howto">
      <summary>{uiText("怎麼打開 {app}？", { app })}</summary>
      <ol>
        <li>{uiText("按鍵盤的 Windows 鍵，輸入 PowerShell，按 Enter。")}</li>
        <li>{uiText("在跳出來的視窗輸入 {command}，按 Enter。", { command: AGENT_COMMAND_V1[target] })}</li>
        <li>{uiText("按 Ctrl+V 貼上剛剛複製的話，再按 Enter。")}</li>
      </ol>
      {restart && <p>{uiText("如果 {app} 本來就開著，先關掉再打開，它才會認得 Editkin。", { app })}</p>}
    </details>
    {result?.vaSkill?.installed === false && <section className="agent-easy-optional" aria-labelledby="agent-easy-va-title" data-testid="agent-connect-va-optional">
      <EasyIcon name="sparkles" />
      <div>
        <h3 id="agent-easy-va-title">{uiText("想剪得更好？可以再裝「影片自動剪輯技能」（選用）")}</h3>
        <p>{uiText("不裝也能用。裝了以後，AI 會照更完整的規則剪片。")}</p>
        <button type="button" className="easy-link" data-testid="agent-connect-va-open" onClick={() => void flow.openKit()}><ExternalIcon /><span>{uiText("看怎麼裝")}</span></button>
        <small className="agent-easy-url"><PathText path={AGENT_KIT_URL_V1} /></small>
      </div>
    </section>}
    <PageNotice state={state} flow={flow} app={app} />
    <div className="easy-actions agent-easy-finish">
      <Secondary icon="check" label={uiText("完成")} onClick={onClose} testId="agent-connect-done" />
    </div>
    {folder && <p className="easy-muted" data-testid="agent-connect-folder-line">{uiText("AI 用的資料夾：{folder}", { folder })}</p>}
    <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="folder-open" label={uiText("換資料夾")} onClick={flow.changeFolder} testId="agent-connect-success-change-folder" />
      <LinkButton icon="arrow-left" label={uiText("連接另一個 AI")} onClick={flow.connectAnother} testId="agent-connect-another" />
    </nav>
    {(result?.message || result?.verification || typeof result?.runtimeToolCount === "number") && <details className="easy-details agent-easy-tech" data-testid="agent-connect-detail">
      <summary>{uiText("技術細節")}</summary>
      {typeof result?.runtimeToolCount === "number" && <p>{uiText("已確認 Editkin 的 {count} 個剪輯工具可以啟動", { count: result.runtimeToolCount })}</p>}
      {result?.message && <p>{translateUiStatus(result.message)}</p>}
      {result?.verification && <p>{result.verification}</p>}
    </details>}
  </Frame>;
}

export function AgentProblemScreen({ state, flow, headingRef }: AgentConnectScreenPropsV1) {
  const problem = state.problem;
  if (!problem) return null;
  const app = flow.appName();
  const copy = AGENT_CONNECT_PROBLEM_COPY_V1[problem.code];
  const manualStep = problem.code === "MANUAL_STEP";
  const canPaste = Boolean(problem.fallbackCommand) || problem.commandAlreadyCopied;
  const primary = agentConnectPrimaryV1(problem);
  const folderLabel = problem.code === "WORKSPACE_CHOICE_EXPIRED" ? uiText("再選一次資料夾") : uiText("換一個資料夾");
  const retryLabel = manualStep ? uiText("貼好了，再檢查一次") : uiText("再試一次");
  const manualToggle = { onClick: flow.toggleManual, testId: "agent-connect-manual", expanded: state.manualOpen, controls: "agent-easy-manual" };
  // Beside the main button: 再試一次 when it is not the main one, and 我自己貼指令 when there is a command to paste.
  const retrySecondary = primary !== "retry";
  const manualSecondary = canPaste && primary !== "manual" && !manualStep;
  const target = state.target ?? state.result?.target ?? "claude";
  return <Frame title={uiText(copy.title, { app })} lead={uiText(copy.body, { app })} icon="alert" tone="warning" headingRef={headingRef} screen="problem">
    {/* Where it stopped; a problem found before connecting started (the app or the skill is missing) has no step to mark. */}
    {problem.step && problem.step !== "detect" && <Stages state={state} app={app} />}
    <div className="easy-cta">
      {primary === "retry" ? <Primary icon="refresh" label={retryLabel} onClick={() => void flow.retry()} testId="agent-connect-retry" busy={state.retrying} />
        : primary === "manual" ? <Primary icon="pencil" label={uiText("我自己貼指令")} {...manualToggle} />
          : <Primary icon="folder-open" label={folderLabel} onClick={flow.changeFolder} testId="agent-connect-choose-folder-again" />}
    </div>
    {state.retrying && state.lastChoice?.kind === "picked" && <p className="easy-hint" data-testid="agent-connect-retry-picker"><EasyIcon name="folder-open" /><span>{uiText("請在跳出來的視窗裡選一個資料夾。")}</span></p>}
    {(retrySecondary || manualSecondary) && <div className="easy-actions agent-easy-fixes">
      {retrySecondary && <Secondary icon="refresh" label={uiText("再試一次")} onClick={() => void flow.retry()} testId="agent-connect-retry" busy={state.retrying} />}
      {manualSecondary && <Secondary icon="pencil" label={uiText("我自己貼指令")} {...manualToggle} />}
    </div>}
    {copy.fix && <PageButton label={uiText(AGENT_CONNECT_FIX_LABEL_V1[copy.fix], { app })} url={AGENT_CONNECT_FIX_URL_V1(copy.fix, target)}
      onClick={() => void flow.fix(copy.fix!)} testId={`agent-connect-fix-${copy.fix}`} />}
    <PageNotice state={state} flow={flow} app={app} />
    {state.manualOpen && canPaste && <section className="agent-easy-manual" id="agent-easy-manual" aria-labelledby="agent-easy-manual-title" data-testid="agent-connect-manual-panel">
      <h3 id="agent-easy-manual-title">{uiText("自己貼一次指令")}</h3>
      {problem.commandAlreadyCopied && <p className="easy-note" data-testid="agent-connect-command-copied"><EasyIcon name="check" /><span>{uiText("指令已經複製好了。")}</span></p>}
      {problem.fallbackCommand && <>
        <pre className="agent-easy-code agent-easy-command" data-testid="agent-connect-fallback-command" data-authored-content="agent-command">{problem.fallbackCommand}</pre>
        <Copied state={state} kind="fallback" idle={uiText("複製指令")} done={uiText("指令已複製")} onClick={() => void flow.copy("fallback")} testId="agent-connect-copy-fallback" primary={false} />
        <CopyFailed state={state} kind="fallback" />
      </>}
      <ol className="agent-easy-keys" aria-label={uiText("貼上指令的步驟")}>
        <li>{uiText("按鍵盤的 Windows 鍵")}</li>
        <li>{uiText("輸入 PowerShell（用「命令提示字元」也可以）")}</li>
        <li>{uiText("按 Enter")}</li>
        <li>{uiText("按 Ctrl+V 貼上")}</li>
        <li>{uiText("再按一次 Enter")}</li>
      </ol>
      <p className="easy-muted">{manualStep ? uiText("貼好以後，回來按「貼好了，再檢查一次」。") : uiText("貼好以後，回來按「再試一次」。")}</p>
    </section>}
    <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="copy" label={state.copied?.kind === "report" && state.copied.ok ? uiText("問題報告已複製") : uiText("複製問題報告")}
        onClick={() => void flow.copy("report")} testId="agent-connect-copy-report" />
      <LinkButton icon="arrow-left" label={uiText("換一個 AI")} onClick={flow.connectAnother} testId="agent-connect-another" />
    </nav>
    {state.copied?.kind === "report" && state.copied.ok && <p className="easy-muted" data-testid="agent-connect-report-copied">{uiText("可以貼到 GitHub 的問題回報。")}</p>}
    <CopyFailed state={state} kind="report" />
    {(problem.detail || problem.logPath) && <details className="easy-details agent-easy-reason" data-testid="agent-connect-reason">
      <summary>{uiText("查看原因")}</summary>
      {problem.detail && <p>{translateUiStatus(problem.detail)}</p>}
      {problem.logPath && <p>{uiText("紀錄檔：{path}", { path: problem.logPath })}</p>}
    </details>}
  </Frame>;
}

/** The current step, plus one polite line that says when something was copied. */
export function AgentConnectScreen(props: AgentConnectScreenPropsV1) {
  const { state } = props;
  const screen = state.screen === "pick" ? <AgentPickScreen {...props} />
    : state.screen === "folder" ? <AgentFolderScreen {...props} />
      : state.screen === "connecting" ? <AgentConnectingScreen {...props} />
        : state.screen === "success" ? <AgentSuccessScreen {...props} />
          : <AgentProblemScreen {...props} />;
  return <>
    {screen}
    <p className="visually-hidden" role="status" aria-live="polite" data-testid="agent-connect-copy-status">
      {state.copied ? state.copied.ok ? uiText("已複製") : uiText("沒有複製成功") : ""}
    </p>
  </>;
}
