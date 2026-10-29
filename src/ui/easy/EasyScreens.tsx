import type { ReactNode, Ref } from "react";
import { translateUi as uiText } from "../i18n/interfacePreferences";
import { translateExportRefusalTextV1 } from "../i18n/exportRefusalTranslationV1";
import type { EasyFlowController } from "./easyFlowController";
import {
  EASY_BRAND_MAX, EASY_DESCRIPTION_MAX, EASY_GENRES, EASY_HOOK_MAX, EASY_POINT_MAX, EASY_POINTS_MIN, EASY_TITLE_MAX, easyQuestionCount,
  filledPoints, firstUnsupportedBrandCharacter, firstUnsupportedCharacter, formatEasyClock, textLength,
  type EasyArtFlagKind, type EasyFlowState, type EasyFormat, type EasyFormatStatus, type EasyGenre, type EasyProblem, type EasyProblemKind,
  type EasyRun, type EasySaveJob, type EasyUnavailableReason, type EasyVideo,
} from "./easyFlowModel";
import { elapsedWords, isRenderStageName, remainingWords, renderStageDetail, type DurationWords } from "../../application/renderProgressModel";
import { EasyIcon, type EasyIconName } from "./easyIcons";
import { recentOpenedWords, type EasyRecentView } from "./easyRecentProjects";
import { AgentHelpCardLive } from "../agentConnect/AgentHelpEntryV1";

/**
 * Pure screens of the easy flow. They hold no state and use no hooks: EasyFlow passes the current state,
 * the controller and a few element refs. Exactly one primary button per screen (none while waiting).
 */
export interface EasyScreenProps {
  state: EasyFlowState;
  controller: EasyFlowController;
  formatStatus: (format: EasyFormat) => EasyFormatStatus;
  videoUrls: { thumbnailUrl?: string; previewUrl?: string };
  canReveal: boolean;
  picker: "dialog" | "file-input" | "demo";
  /** First screen primary: opens the chooser (or the browser file input). */
  onChooseVideo: () => void;
  onFilesChosen: (files: File[]) => void;
  onSeekPreview: (second: number) => void;
  now: number;
  headingRef?: Ref<HTMLHeadingElement>;
  fileInputRef?: Ref<HTMLInputElement>;
  previewRef?: Ref<HTMLVideoElement>;
  /** The text field an inline 「先寫…」 message points at (the title, or the first missing key point); EasyFlow focuses it. */
  titleInputRef?: Ref<HTMLInputElement>;
  /** Recent projects for the first screen; absent in the plain browser build and when there are none. */
  recent?: EasyRecentView;
  /** Desktop only: the 「讓 AI 幫我剪片」 card at the bottom of the first screen (the same dialog as the top bar and the advanced start). */
  onConnectAgent?: () => void;
  /** The running 「存成影片」 and its stop question (EasyFlow holds the question; the job comes from the host). */
  save?: EasySaveControls;
  /** 「播放」 on the saved screen: plays the saved file in the in-app player (previewRef). */
  onPlaySaved?: () => void;
}

export interface EasySaveControls {
  job?: EasySaveJob;
  confirmingStop: boolean;
  askStop: () => void;
  keepSaving: () => void;
  stop: () => void;
}

function genreLabel(genre: EasyGenre): string {
  switch (genre) {
    case "travel": return uiText("旅遊");
    case "food": return uiText("美食");
    case "teaching": return uiText("教學");
    case "unboxing": return uiText("開箱");
    case "game": return uiText("遊戲");
    case "life": return uiText("生活");
    default: return uiText("不確定？讓電腦幫我選");
  }
}
const GENRE_ICONS: Record<EasyGenre, EasyIconName> = {
  travel: "suitcase", food: "bowl", teaching: "book", unboxing: "box", game: "gamepad", life: "cup", auto: "sparkles",
};

function formatBadge(status: EasyFormatStatus): string | undefined {
  if (status === "shorts-connecting") return uiText("自動剪輯還在接上");
  if (status === "needs-desktop") return uiText("要用桌面版");
  return undefined;
}
function formatNote(status: EasyFormatStatus): string | undefined {
  if (status === "shorts-connecting") return uiText("直的短影音的自動剪輯還在接上。選了影片之後，可以先在剪輯台自己剪。");
  if (status === "needs-desktop") return uiText("自動剪輯要在 Editkin 桌面版裡用。選了影片之後，可以先在剪輯台自己剪。");
  return undefined;
}
function problemText(problem: EasyProblem): string {
  switch (problem.kind) {
    case "not-video": return uiText("請選一支影片（照片和聲音不行）。");
    case "too-many": return uiText("一次選一支影片就好。");
    case "import-failed": return uiText("這支影片沒有放進來。可以再選一次，或換一支影片。");
    case "save-failed": return uiText("這次沒有存好，可以再試一次。");
    case "rights-failed": return uiText("沒有記下來，可以再試一次。");
    case "open-failed": return uiText("剪好的影片沒有打開，可以再試一次。");
    default: return uiText("原本的影片沒有被改動。可以再試一次，或到剪輯台自己剪。");
  }
}
function failureText(kind: EasyProblemKind): string {
  switch (kind) {
    case "words": return uiText("字太多或有特別的字，畫面放不下。改一下文字再試一次。");
    case "no-space": return uiText("電腦的空間不夠了。清出一些空間後再試一次。");
    case "stalled": return uiText("很久都沒有進展，所以先停下來了。原本的影片沒有被改動，可以再試一次。");
    case "not-allowed": return uiText("這支影片沒有被確認是你自己拍的，所以不能自動剪。可以換一支影片，或到剪輯台自己剪。");
    case "settings": return uiText("自動剪輯的設定有問題，請先修好再試一次。");
    default: return uiText("原本的影片沒有被改動。可以再試一次，或到剪輯台自己剪。");
  }
}
function flagText(kind: EasyArtFlagKind): string {
  switch (kind) {
    case "text-cut": return uiText("標題有一點被切到");
    case "text-small": return uiText("字太小，手機上可能看不清楚");
    case "text-overlap": return uiText("有字疊在一起");
    case "stutter": return uiText("動畫卡了一下");
    case "too-still": return uiText("畫面停太久");
    default: return uiText("這裡要再看一次");
  }
}
function unavailableCopy(reason: EasyUnavailableReason): { title: string; body: string } {
  switch (reason) {
    case "shorts-connecting": return { title: uiText("直的短影音還不能自動剪"), body: uiText("自動做直的短影音的功能正在接上。你的影片已經放好了，可以先在剪輯台自己剪。") };
    case "video-not-horizontal": return { title: uiText("這支影片不是橫著拍的"), body: uiText("「橫的影片」只能用橫著拍的影片自動剪。可以換一支影片，或先在剪輯台自己剪。") };
    case "video-too-short": return { title: uiText("這支影片太短了"), body: uiText("直的短影音要用 5 秒以上的影片。可以換一支影片，或先在剪輯台自己剪。") };
    case "outside-workspace": return { title: uiText("這支影片不在工作資料夾裡"), body: uiText("直的短影音只能用工作資料夾裡的影片。把影片放進工作資料夾後再選一次，或先在剪輯台自己剪。") };
    case "not-own-footage": return { title: uiText("只能用你自己拍的影片"), body: uiText("直的短影音只會用你自己拍的影片自動剪。你的影片已經放好了，可以先在剪輯台自己剪。") };
    case "check-failed": return { title: uiText("現在還不能自動剪這支影片"), body: uiText("檢查影片的時候出了問題。可以換一支影片，或先在剪輯台自己剪。") };
    default: return { title: uiText("這裡還不能自動剪"), body: uiText("自動剪輯要在 Editkin 桌面版裡用。你的影片已經放好了，可以先在剪輯台自己剪。") };
  }
}
function timeText(run: EasyRun, now: number): string {
  const elapsed = Math.max(0, (now - run.startedAt) / 1000);
  if (run.estimateSeconds) {
    const left = Math.ceil(run.estimateSeconds - elapsed);
    if (left <= 0) return uiText("快好了，再等一下");
    if (left >= 90) return uiText("大約還要 {minutes} 分鐘", { minutes: Math.round(left / 60) });
    return uiText("大約還要 {seconds} 秒", { seconds: left });
  }
  return uiText("已經過了 {time}", { time: formatEasyClock(elapsed) });
}

function Frame(props: { title: string; lead?: string; onBack?: () => void; step?: { current: number; total: number };
  icon?: EasyIconName; tone?: "info" | "success" | "warning"; headingRef?: Ref<HTMLHeadingElement>; className?: string; children?: ReactNode }) {
  const { title, lead, onBack, step, icon, tone = "info", headingRef, className, children } = props;
  return <div className={className ? `easy-screen ${className}` : "easy-screen"}>
    {(onBack || step) && <div className="easy-topbar">
      {onBack ? <button type="button" className="easy-back" onClick={onBack} data-testid="easy-back"><EasyIcon name="arrow-left" /><span>{uiText("上一步")}</span></button> : <span />}
      {step && <span className="easy-step">{uiText("第 {current} 步，共 {total} 步", step)}</span>}
    </div>}
    {icon && <div className={`easy-hero-icon easy-tone-${tone}`}><EasyIcon name={icon} /></div>}
    <h1 id="easy-flow-title" className="easy-title" tabIndex={-1} ref={headingRef}>{title}</h1>
    {lead && <p className="easy-lead">{lead}</p>}
    {children}
  </div>;
}

function Primary(props: { icon: EasyIconName; label: string; onClick?: () => void; testId: string; type?: "button" | "submit"; busy?: boolean }) {
  return <button type={props.type ?? "button"} className="easy-primary" data-easy-primary="" data-testid={props.testId}
    onClick={props.onClick} disabled={props.busy} aria-busy={props.busy || undefined}>
    {props.busy ? <span className="easy-spinner" aria-hidden="true" /> : <EasyIcon name={props.icon} />}<span>{props.label}</span>
  </button>;
}

function Secondary(props: { icon: EasyIconName; label: string; onClick: () => void; testId: string; disabled?: boolean }) {
  return <button type="button" className="easy-secondary" data-testid={props.testId} onClick={props.onClick} disabled={props.disabled}><EasyIcon name={props.icon} /><span>{props.label}</span></button>;
}

function LinkButton(props: { icon?: EasyIconName; label: string; onClick: () => void; testId: string }) {
  return <button type="button" className="easy-link" data-testid={props.testId} onClick={props.onClick}>{props.icon && <EasyIcon name={props.icon} />}<span>{props.label}</span></button>;
}

function Problem({ problem }: { problem: EasyProblem }) {
  return <div className="easy-alert" role="alert" data-testid="easy-problem">
    <EasyIcon name="alert" />
    <div><p>{problemText(problem)}</p>
      {problem.detail && <details><summary>{uiText("查看原因")}</summary><p>{translateExportRefusalTextV1(problem.detail)}</p></details>}</div>
  </div>;
}

/** The character itself is the creator's own text, shown as typed. */
function GlyphError({ id, character }: { id: string; character: string }) {
  return <p id={id} className="easy-error" role="alert" data-testid="easy-glyph-error"><EasyIcon name="alert" />
    <span>{uiText("「{character}」這個字沒辦法放上畫面，請換一個字", { character })}</span></p>;
}

function VideoChip({ video, urls }: { video: EasyVideo; urls: EasyScreenProps["videoUrls"] }) {
  return <div className="easy-video-chip" data-testid="easy-video-chip">
    <span className="easy-video-thumb" aria-hidden="true">
      {urls.thumbnailUrl ? <img src={urls.thumbnailUrl} alt="" />
        : urls.previewUrl ? <video src={`${urls.previewUrl}#t=0.5`} muted playsInline preload="metadata" tabIndex={-1} />
          : <EasyIcon name={video.orientation === "portrait" ? "phone" : "screen"} />}
    </span>
    <span className="easy-video-text"><small>{uiText("你的影片")}</small>
      <strong title={video.name}>{video.name}</strong>
      {video.durationSeconds ? <span className="easy-video-time">{formatEasyClock(video.durationSeconds)}</span> : null}</span>
  </div>;
}

const HONESTY_NOTE = () => <p className="easy-note" data-testid="easy-honesty-note"><EasyIcon name="info" /><span>{uiText("店名、價格、數字請照實寫，電腦不會自己亂加。")}</span></p>;

/**
 * Recent projects on the first screen: one big button each with the name and, in plain words, when it was last
 * opened. A file that is gone says so on its own row and offers 「從清單移除」 (the list only; no file is touched).
 */
function RecentProjects({ view }: { view: EasyRecentView }) {
  return <section className="easy-recent" aria-labelledby="easy-recent-title" data-testid="easy-recent">
    <h2 id="easy-recent-title" className="easy-recent-title">{uiText("最近的作品")}</h2>
    <ul className="easy-recent-list">
      {view.items.map((item, index) => {
        const gone = item.state === "missing", opening = item.state === "opening";
        return <li key={item.path} className="easy-recent-item" data-state={item.state} data-testid={`easy-recent-item-${index}`}>
          <button type="button" className="easy-recent-open" data-testid={`easy-recent-open-${index}`} title={item.path}
            disabled={gone || view.busy} aria-busy={opening || undefined} onClick={() => view.onOpen(item.path)}>
            {opening ? <span className="easy-spinner" aria-hidden="true" /> : <EasyIcon name={gone ? "alert" : "folder-open"} className="easy-recent-icon" />}
            <span className="easy-recent-text">
              <strong>{item.name}</strong>
              <small>{opening ? uiText("正在打開…") : uiText("上次打開：{when}", { when: recentOpenedWords(item.openedAt, view.now) })}</small>
              {item.folder && <small className="easy-recent-folder">{item.folder}</small>}
            </span>
            {!gone && !opening && <EasyIcon name="arrow-right" className="easy-recent-go" />}
          </button>
          {gone && <div className="easy-recent-problem" role={item.announce ? "alert" : undefined} data-testid={`easy-recent-missing-${index}`}>
            <p>{uiText("找不到這個檔案了，可能被移走或刪掉了。")}</p>
            <button type="button" className="easy-recent-forget" data-testid={`easy-recent-forget-${index}`} onClick={() => view.onForget(item.path)}>{uiText("從清單移除")}</button>
          </div>}
          {item.state === "failed" && item.problem && <div className="easy-recent-problem" role={item.announce ? "alert" : undefined} data-testid={`easy-recent-failed-${index}`}>
            <p>{uiText(item.problem.what)}</p>
            {item.problem.detail && <details className="easy-details"><summary>{uiText("查看原因")}</summary><p>{item.problem.detail}</p></details>}
          </div>}
        </li>;
      })}
    </ul>
  </section>;
}

export function EasyHomeScreen(props: EasyScreenProps) {
  const { state, controller, formatStatus, picker } = props;
  const card = (format: EasyFormat) => {
    const selected = state.format === format;
    const badge = formatBadge(formatStatus(format));
    return <label key={format} className="easy-choice easy-format" data-selected={selected} data-format={format} data-testid={`easy-format-${format}`}>
      <input className="easy-radio" type="radio" name="easy-format" value={format} checked={selected} disabled={state.picking}
        onChange={() => controller.chooseFormat(format)} />
      <span className={`easy-frame easy-frame-${format}`} aria-hidden="true"><EasyIcon name="play" /></span>
      <span className="easy-choice-text"><strong>{format === "vertical" ? uiText("直的短影音") : uiText("橫的影片")}</strong>
        <small>{format === "vertical" ? uiText("Shorts、Reels") : "YouTube"}</small></span>
      {badge && <span className="easy-badge">{badge}</span>}
      <span className="easy-check" aria-hidden="true"><EasyIcon name="check" /></span>
    </label>;
  };
  const note = state.format ? formatNote(formatStatus(state.format)) : undefined;
  return <Frame title={uiText("放影片進來，我幫你剪好")} lead={uiText("先選要做哪一種，再選一支你拍的影片。")} headingRef={props.headingRef} className="easy-home">
    <fieldset className="easy-choices" aria-describedby={state.formatHint ? "easy-format-hint" : undefined}>
      <legend className="easy-legend">{uiText("要做哪一種影片？")}</legend>
      <div className="easy-format-grid">{card("vertical")}{card("horizontal")}</div>
    </fieldset>
    {state.formatHint && <p id="easy-format-hint" className="easy-hint" role="alert" data-testid="easy-format-hint"><EasyIcon name="info" /><span>{uiText("先點一下你要做哪一種影片")}</span></p>}
    {note && !state.formatHint && <p className="easy-note" data-testid="easy-format-note"><EasyIcon name="info" /><span>{note}</span></p>}
    {state.pickProblem && <Problem problem={state.pickProblem} />}
    <div className="easy-cta">
      <Primary icon="folder-plus" label={state.picking ? uiText("正在放進來…") : uiText("選擇影片")} onClick={props.onChooseVideo} testId="easy-choose-video" busy={state.picking} />
      {state.picking && <p className="visually-hidden" role="status">{uiText("正在放進來…")}</p>}
    </div>
    {picker === "file-input" && <input ref={props.fileInputRef} className="visually-hidden" type="file" accept="video/*" tabIndex={-1} aria-hidden="true"
      data-testid="easy-file-input" onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) props.onFilesChosen(files);
      }} />}
    <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="scissors" label={uiText("我想自己剪")} onClick={controller.openWorkspace} testId="easy-edit-myself" />
      <LinkButton icon="folder-open" label={uiText("打開之前的作品")} onClick={controller.openProject} testId="easy-open-project" />
    </nav>
    {props.recent && props.recent.items.length > 0 && <RecentProjects view={props.recent} />}
    {/* 「讓 AI 幫我剪片」 (2026-10-29): in plain sight, one big card, the same as the top bar's; below 選擇影片 and the
        other ways in, and not filled, so 選擇影片 stays the one primary button. */}
    {props.onConnectAgent && <section className="easy-ai" aria-label={uiText("讓 AI 幫我剪片")} data-testid="easy-ai-section">
      <AgentHelpCardLive onClick={props.onConnectAgent} />
    </section>}
  </Frame>;
}

/** Asked once, before anything is written: only an explicit 「是，這是我自己拍的素材」 records the creator's confirmation. */
export function EasyRightsScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const rights = state.rights;
  if (!rights) return null;
  const glyph = firstUnsupportedBrandCharacter(rights.brandName);
  const describedBy = ["easy-brand-hint", glyph ? "easy-brand-glyph" : ""].filter(Boolean).join(" ");
  return <Frame title={uiText("這些影片是你自己拍的嗎？")} lead={uiText("只有你自己拍的影片，才能自動做成直的短影音。")} onBack={rights.busy ? undefined : controller.back}
    headingRef={props.headingRef} className="easy-rights">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <p className="easy-note" data-testid="easy-rights-scope"><EasyIcon name="info" /><span>{rights.scope.kind === "folder"
      ? uiText("選「是」，就表示「{folder}」資料夾裡的影片都是你自己拍的。以後不會再問。", { folder: rights.scope.name })
      : uiText("選「是」，就表示這支影片是你自己拍的。以後不會再問。")}</span></p>
    <form className="easy-form" noValidate onSubmit={event => { event.preventDefault(); void controller.confirmRights(); }}>
      <div className="easy-field" data-invalid={Boolean(glyph)}>
        <label htmlFor="easy-brand-input">{uiText("你的名字或品牌（可以不寫）")}</label>
        <input id="easy-brand-input" className="easy-input" type="text" value={rights.brandName} maxLength={EASY_BRAND_MAX} autoComplete="off" disabled={rights.busy}
          aria-describedby={describedBy} data-testid="easy-brand-input" onChange={event => controller.setBrandName(event.currentTarget.value)} />
        <span id="easy-brand-hint" className="easy-counter">{uiText("寫了會小小地出現在影片開頭，最多 16 個字。")}</span>
        {glyph && <GlyphError id="easy-brand-glyph" character={glyph} />}
      </div>
      {rights.problem && <Problem problem={rights.problem} />}
      <div className="easy-cta">
        <Primary type="submit" icon="check" label={rights.busy ? uiText("正在記下來…") : uiText("是，這是我自己拍的素材")} testId="easy-rights-yes" busy={rights.busy} />
      </div>
    </form>
    {!rights.busy && <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="scissors" label={uiText("不是，我先自己剪")} onClick={controller.declineRights} testId="easy-rights-no" />
    </nav>}
  </Frame>;
}

export function EasyGenreScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const needsTitle = state.plan?.needsTitle !== false;
  const card = (genre: EasyGenre) => <label key={genre} className={genre === "auto" ? "easy-choice easy-genre easy-genre-auto" : "easy-choice easy-genre"}
    data-selected={state.genre === genre} data-testid={`easy-genre-${genre}`}>
    <input className="easy-radio" type="radio" name="easy-genre" value={genre} checked={state.genre === genre} onChange={() => controller.chooseGenre(genre)} />
    <span className="easy-genre-icon" aria-hidden="true"><EasyIcon name={GENRE_ICONS[genre]} /></span>
    <strong>{genreLabel(genre)}</strong>
    <span className="easy-check" aria-hidden="true"><EasyIcon name="check" /></span>
  </label>;
  return <Frame title={uiText("這支影片在拍什麼？")} lead={uiText("選一個最接近的，剪的樣子會跟著變。")} onBack={controller.back}
    step={{ current: 2, total: easyQuestionCount(state.plan, state.hookSkipped) }} headingRef={props.headingRef} className="easy-genre-screen">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <fieldset className="easy-choices">
      <legend className="visually-hidden">{uiText("這支影片在拍什麼？")}</legend>
      <div className="easy-genre-grid">{EASY_GENRES.map(card)}</div>
      {card("auto")}
    </fieldset>
    {!needsTitle && <p className="easy-note" data-testid="easy-engine-summary"><EasyIcon name="info" /><span>{uiText("這一版會剪掉停頓的地方、加上字幕和音樂；不會在畫面上加標題。")}</span></p>}
    <div className="easy-cta">
      {needsTitle
        ? <Primary icon="arrow-right" label={uiText("下一步")} onClick={controller.confirmGenre} testId="easy-genre-next" />
        : <Primary icon="sparkles" label={uiText("開始自動剪輯")} onClick={controller.confirmGenre} testId="easy-start" />}
    </div>
  </Frame>;
}

/** 大家原本以為…: optional. Writing it makes the Short 「原本以為 → 其實是」; skipping it asks for 2–4 points later. */
export function EasyHookScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const glyph = firstUnsupportedCharacter(state.hook);
  const describedBy = ["easy-hook-count", glyph ? "easy-hook-glyph" : ""].filter(Boolean).join(" ");
  return <Frame title={uiText("大家原本以為……")} lead={uiText("先寫大家原本以為的事，下一步再寫其實是什麼。這一步可以不寫。")} onBack={controller.back}
    step={{ current: 3, total: easyQuestionCount(state.plan) }} headingRef={props.headingRef} className="easy-title-screen easy-hook-screen">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <form className="easy-form" noValidate onSubmit={event => { event.preventDefault(); controller.submitHook(); }}>
      <div className="easy-field" data-invalid={Boolean(glyph)}>
        <label htmlFor="easy-hook-input">{uiText("大家原本以為（可以不寫）")}</label>
        <input id="easy-hook-input" className="easy-input easy-input-title" type="text" value={state.hook} maxLength={EASY_HOOK_MAX} autoComplete="off"
          aria-describedby={describedBy} data-testid="easy-hook-input" placeholder={uiText("例如：來看蝙蝠")}
          onChange={event => controller.setHook(event.currentTarget.value)} />
        <span id="easy-hook-count" className="easy-counter">{uiText("還可以打 {count} 個字", { count: Math.max(0, EASY_HOOK_MAX - textLength(state.hook)) })}</span>
        {glyph && <GlyphError id="easy-hook-glyph" character={glyph} />}
      </div>
      <div className="easy-cta">
        <Primary type="submit" icon="arrow-right" label={uiText("下一步")} testId="easy-hook-next" />
      </div>
    </form>
    <div className="easy-actions easy-skip">
      <Secondary icon="arrow-right" label={uiText("跳過這一步")} onClick={controller.skipHook} testId="easy-hook-skip" />
    </div>
  </Frame>;
}

/** 其實是…: the big title (required). With a hook it is the last question; without one, the points come next. */
function EasyStoryTitleScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const glyph = firstUnsupportedCharacter(state.title);
  const hook = state.hookSkipped ? "" : state.hook.trim();
  const describedBy = ["easy-title-count", state.titleError ? "easy-title-error" : "", glyph ? "easy-title-glyph" : ""].filter(Boolean).join(" ");
  return <Frame title={uiText("其實是……")} lead={hook ? uiText("大家原本以為「{hook}」，其實是什麼？", { hook }) : uiText("寫一句最想讓大家知道的話。")}
    onBack={controller.back} step={{ current: 4, total: easyQuestionCount(state.plan, state.hookSkipped) }} headingRef={props.headingRef} className="easy-title-screen">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <form className="easy-form" noValidate onSubmit={event => { event.preventDefault(); controller.submitTitle(); }}>
      <div className="easy-field" data-invalid={state.titleError || Boolean(glyph)}>
        <label htmlFor="easy-title-input">{uiText("大標題（一定要寫）")}</label>
        <input id="easy-title-input" ref={props.titleInputRef} className="easy-input easy-input-title" type="text" value={state.title} maxLength={EASY_TITLE_MAX}
          autoComplete="off" aria-required="true" aria-invalid={state.titleError || Boolean(glyph)} aria-describedby={describedBy} data-testid="easy-title-input"
          placeholder={uiText("例如：其實是來看水簾的")} onChange={event => controller.setTitle(event.currentTarget.value)} />
        <span id="easy-title-count" className="easy-counter">{uiText("還可以打 {count} 個字", { count: Math.max(0, EASY_TITLE_MAX - textLength(state.title)) })}</span>
        {state.titleError && <p id="easy-title-error" className="easy-error" role="alert" data-testid="easy-title-error"><EasyIcon name="alert" /><span>{uiText("先寫一句大標題")}</span></p>}
        {glyph && <GlyphError id="easy-title-glyph" character={glyph} />}
      </div>
      <HONESTY_NOTE />
      <div className="easy-cta">
        {state.hookSkipped
          ? <Primary type="submit" icon="arrow-right" label={uiText("下一步")} testId="easy-title-next" />
          : <Primary type="submit" icon="sparkles" label={uiText("開始自動剪輯")} testId="easy-start" />}
      </div>
    </form>
  </Frame>;
}

export function EasyTitleScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  if (state.plan?.copy === "story") return <EasyStoryTitleScreen {...props} />;
  const left = EASY_TITLE_MAX - textLength(state.title);
  const describedBy = ["easy-title-count", state.titleError ? "easy-title-error" : ""].filter(Boolean).join(" ");
  return <Frame title={uiText("畫面上要寫什麼？")} onBack={controller.back} step={{ current: 3, total: easyQuestionCount(state.plan) }}
    headingRef={props.headingRef} className="easy-title-screen">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <form className="easy-form" noValidate onSubmit={event => { event.preventDefault(); controller.submitTitle(); }}>
      <div className="easy-field" data-invalid={state.titleError}>
        <label htmlFor="easy-title-input">{uiText("大標題（一定要寫）")}</label>
        <input id="easy-title-input" ref={props.titleInputRef} className="easy-input easy-input-title" type="text" value={state.title} maxLength={EASY_TITLE_MAX}
          autoComplete="off" aria-required="true" aria-invalid={state.titleError} aria-describedby={describedBy} data-testid="easy-title-input"
          placeholder={uiText("例如：其實是來看水簾的")} onChange={event => controller.setTitle(event.currentTarget.value)} />
        <span id="easy-title-count" className="easy-counter">{uiText("還可以打 {count} 個字", { count: Math.max(0, left) })}</span>
        {state.titleError && <p id="easy-title-error" className="easy-error" role="alert" data-testid="easy-title-error"><EasyIcon name="alert" /><span>{uiText("先寫一句大標題")}</span></p>}
      </div>
      <div className="easy-field">
        <label htmlFor="easy-description-input">{uiText("一句說明（可以不寫）")}</label>
        <input id="easy-description-input" className="easy-input" type="text" value={state.description} maxLength={EASY_DESCRIPTION_MAX} autoComplete="off"
          data-testid="easy-description-input" placeholder={uiText("例如：名字叫蝙蝠洞，但現在沒有蝙蝠")}
          onChange={event => controller.setDescription(event.currentTarget.value)} />
      </div>
      <HONESTY_NOTE />
      <div className="easy-cta">
        <Primary type="submit" icon="sparkles" label={uiText("開始自動剪輯")} testId="easy-start" />
      </div>
    </form>
  </Frame>;
}

/** Only when 大家原本以為 was skipped: 2–4 short points under the big title. */
export function EasyPointsScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  // After 至少寫兩個重點: mark just as many empty fields as are still needed, first ones first, and send the cursor to the first.
  const needed = state.pointsError ? Math.max(0, EASY_POINTS_MIN - filledPoints(state.points).length) : 0;
  const missingPoints = state.points.flatMap((point, index) => point.trim() ? [] : [index]).slice(0, needed);
  return <Frame title={uiText("重點是哪幾個？")} lead={uiText("寫 2 到 4 個重點，每個短短一句。")} onBack={controller.back}
    step={{ current: 5, total: easyQuestionCount(state.plan, true) }} headingRef={props.headingRef} className="easy-title-screen easy-points-screen">
    <form className="easy-form" noValidate onSubmit={event => { event.preventDefault(); controller.submitPoints(); }}>
      {state.points.map((point, index) => {
        const number = index + 1, glyph = firstUnsupportedCharacter(point), id = `easy-point-input-${number}`;
        const missing = missingPoints.includes(index), invalid = Boolean(glyph) || missing;
        const describedBy = [`${id}-count`, glyph ? `${id}-glyph` : "", state.pointsError ? "easy-points-error" : ""].filter(Boolean).join(" ");
        return <div key={index} className="easy-field" data-invalid={invalid}>
          <label htmlFor={id}>{index < EASY_POINTS_MIN ? uiText("重點 {number}", { number }) : uiText("重點 {number}（可以不寫）", { number })}</label>
          <input id={id} ref={index === missingPoints[0] ? props.titleInputRef : undefined} className="easy-input" type="text" value={point}
            maxLength={EASY_POINT_MAX} autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid}
            aria-required={index < EASY_POINTS_MIN || undefined} data-testid={id} placeholder={index === 0 ? uiText("例如：洞口就看得到水簾") : undefined}
            onChange={event => controller.setPoint(index, event.currentTarget.value)} />
          <span id={`${id}-count`} className="easy-counter">{uiText("還可以打 {count} 個字", { count: Math.max(0, EASY_POINT_MAX - textLength(point)) })}</span>
          {glyph && <GlyphError id={`${id}-glyph`} character={glyph} />}
        </div>;
      })}
      {state.pointsError && <p id="easy-points-error" className="easy-error" role="alert" data-testid="easy-points-error"><EasyIcon name="alert" /><span>{uiText("至少寫兩個重點")}</span></p>}
      <HONESTY_NOTE />
      <div className="easy-cta">
        <Primary type="submit" icon="sparkles" label={uiText("開始自動剪輯")} testId="easy-start" />
      </div>
    </form>
  </Frame>;
}

export function EasyWorkingScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const run = state.run;
  const steps = state.plan?.steps ?? ["", "", "", ""];
  const current = run?.step ?? 0;
  const percent = run ? Math.round(((run.step + run.fraction) / 4) * 100) : 0;
  return <Frame title={uiText("正在幫你剪…")} lead={uiText("剪好之後，這個畫面會自己換，不用一直看著。")} headingRef={props.headingRef} className="easy-working">
    <ol className="easy-steps" data-testid="easy-steps">
      {steps.map((label, index) => {
        const status = index < current ? "done" : index === current ? "current" : "waiting";
        return <li key={index} data-status={status}>
          <span className="easy-step-mark" aria-hidden="true">{status === "done" ? <EasyIcon name="check" /> : status === "current" ? <span className="easy-spinner" /> : <EasyIcon name="circle" />}</span>
          <span className="easy-step-label">{uiText(label)}</span>
          <span className="visually-hidden">{status === "done" ? uiText("做好了") : status === "current" ? uiText("正在做") : uiText("還沒開始")}</span>
        </li>;
      })}
    </ol>
    <div className="easy-progress" role="progressbar" aria-label={uiText("剪輯進度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      data-testid="easy-progress">
      {[0, 1, 2, 3].map(index => <span key={index} className="easy-progress-part"
        data-status={index < current ? "done" : index === current ? "current" : "waiting"}>
        <span style={index === current && run && run.fraction > 0 ? { width: `${Math.round(run.fraction * 100)}%` } : undefined} />
      </span>)}
    </div>
    {run && <p className="easy-time" data-testid="easy-time"><EasyIcon name="clock" /><span>{timeText(run, props.now)}</span></p>}
    {!run?.estimateSeconds && <p className="easy-muted">{uiText("影片越長，要等越久。")}</p>}
    {state.plan?.canCancel && <div className="easy-actions">
      <Secondary icon="stop" label={uiText("停下來")} onClick={controller.cancelRun} testId="easy-cancel" />
    </div>}
  </Frame>;
}

export function EasyResultScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const result = state.result;
  if (!result) return null;
  const plan = state.plan;
  const orientation = result.orientation;
  const media = plan?.rendersPreview && result.previewUrl
    ? <video ref={props.previewRef} className="easy-player" src={result.previewUrl} poster={result.posterUrl} controls playsInline preload="metadata"
      aria-label={uiText("剪好的影片")} data-testid="easy-preview" />
    : <div className="easy-summary" data-testid="easy-summary">
      {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
      {result.summary && <><h2>{uiText("這一版做了這些事：")}</h2>
        <ul>
          <li><EasyIcon name="scissors" /><span>{uiText("剪成 {count} 段", { count: result.summary.segments })}</span></li>
          <li><EasyIcon name="captions" /><span>{uiText("加上 {count} 句字幕", { count: result.summary.captions })}</span></li>
          <li><EasyIcon name="music" /><span>{result.summary.music ? uiText("配上音樂") : uiText("沒有找到合適的音樂")}</span></li>
        </ul></>}
      <p className="easy-note"><EasyIcon name="info" /><span>{uiText("字幕是電腦聽寫的，數字和店名請再看一次。")}</span></p>
      <p className="easy-muted">{uiText("想先看看剪好的樣子，可以按「我想自己細調」，在剪輯台播放。")}</p>
    </div>;
  const seconds = result.usedRange ? Math.round(result.usedRange.seconds * 10) / 10 : 0;
  return <Frame title={uiText("剪好了，你看看")} headingRef={props.headingRef} className={`easy-result-screen easy-result-${orientation}`}>
    {result.flags.length > 0 ? <section className="easy-flags" aria-labelledby="easy-flags-title" data-testid="easy-flags">
      <EasyIcon name="alert" />
      <div>
        <h2 id="easy-flags-title">{uiText("需要修改")}</h2>
        <ul>{result.flags.map((flag, index) => <li key={`${flag.kind}-${flag.second}-${index}`}>
          <span><b>{uiText("第 {second} 秒", { second: flag.second })}</b>{flagText(flag.kind)}</span>
          {plan?.rendersPreview && result.previewUrl && <button type="button" className="easy-chip-button" onClick={() => props.onSeekPreview(flag.second)}
            data-testid="easy-flag-seek">{uiText("去看看")}</button>}
        </li>)}</ul>
        <p>{uiText("影片還是可以先存，之後再改。")}</p>
      </div>
    </section> : result.review ? <section className="easy-flags easy-review" aria-labelledby="easy-review-title" data-testid="easy-review">
      <EasyIcon name="info" />
      <div>
        <h2 id="easy-review-title">{uiText("存之前請先看一遍")}</h2>
        <p>{uiText("這個樣式還沒有經過完整檢查，存之前請自己看一遍。")}</p>
      </div>
    </section> : null}
    {state.saveProblem && <Problem problem={state.saveProblem} />}
    <div className="easy-result">
      <div className="easy-result-media">{media}</div>
      <div className="easy-result-actions">
        {result.usedRange && <p className="easy-note" data-testid="easy-used-range"><EasyIcon name="info" /><span>{result.usedRange.clamped
          ? uiText("這支影片比較長，只用了開頭的 {seconds} 秒。", { seconds })
          : uiText("整支影片都用上了（{seconds} 秒）。", { seconds })}</span></p>}
        <Primary icon="save" label={uiText("好了，存成影片")} onClick={() => void controller.save()} testId="easy-save" />
        {(plan?.canEditText || plan?.canRestyle) && <div className="easy-actions">
          {plan.canEditText && <Secondary icon="pencil" label={uiText("改文字")} onClick={controller.editText} testId="easy-edit-text" />}
          {plan.canRestyle && <Secondary icon="palette" label={uiText("換一種風格")} onClick={controller.restyle} testId="easy-restyle" />}
        </div>}
        <LinkButton icon="sliders" label={uiText("我想自己細調（進入剪輯台）")} onClick={controller.openEditor} testId="easy-fine-tune" />
      </div>
    </div>
  </Frame>;
}

const durationText = (value: DurationWords) => uiText(value.key, value.values);

/** What the saving screen says about the running save: the renderer's step, and a percentage only when it was measured. */
function saveStageText(job: EasySaveJob): string {
  const stage = job.stage && isRenderStageName(job.stage) ? job.stage : "prepare";
  const parts = job.parts ? ` ${uiText("（第 {part}／{parts} 段）", { part: job.part ?? 1, parts: job.parts })}` : "";
  return `${uiText(renderStageDetail(stage))}${parts}`;
}

export function EasySavingScreen(props: EasyScreenProps) {
  const save = props.save;
  const job = save?.job;
  const percent = job?.fraction === undefined ? undefined : Math.floor(job.fraction * 100);
  const elapsedMs = job?.runningSinceMs === undefined ? undefined : Math.max(0, props.now - job.runningSinceMs);
  return <Frame title={uiText("正在存成影片…")} lead={uiText("正在把影片做好，請稍等。影片越長，要等越久。")} icon="save" headingRef={props.headingRef} className="easy-working easy-saving">
    {job && <p className="easy-save-stage" data-testid="easy-saving-stage">{saveStageText(job)}</p>}
    <div className={`easy-progress ${percent === undefined ? "easy-progress-indeterminate" : "easy-progress-measured"}`} role="progressbar" aria-label={uiText("存檔進度")}
      aria-valuemin={percent === undefined ? undefined : 0} aria-valuemax={percent === undefined ? undefined : 100} aria-valuenow={percent}
      aria-valuetext={percent === undefined ? uiText("這一步算不出百分比，請稍候。") : `${percent}%`} data-testid="easy-saving-progress">
      <span style={percent === undefined ? undefined : { width: `${Math.max(2, percent)}%` }} />
    </div>
    {job && <p className="easy-time" data-testid="easy-saving-time"><EasyIcon name="clock" />
      {percent === undefined
        ? <span>{uiText("這一步算不出百分比，請稍候。")}</span>
        : <span>{`${percent}%`} · {job.remainingMs === undefined ? uiText("正在估計剩餘時間…") : durationText(remainingWords(job.remainingMs))}</span>}
    </p>}
    {elapsedMs !== undefined && <p className="easy-muted" data-testid="easy-saving-elapsed">{durationText(elapsedWords(elapsedMs))}</p>}
    {job?.canCancel && save && (save.confirmingStop && !job.cancelRequested
      ? <div className="easy-save-confirm" role="alertdialog" aria-labelledby="easy-save-stop-question" data-testid="easy-save-stop-question">
        <p id="easy-save-stop-question">{uiText("要停止存檔嗎？影片不會存下來，剪好的內容還在。")}</p>
        <div className="easy-actions">
          <Secondary icon="stop" label={uiText("停止存檔")} onClick={save.stop} testId="easy-save-stop-confirm" />
          <Secondary icon="save" label={uiText("繼續存")} onClick={save.keepSaving} testId="easy-save-keep" />
        </div>
      </div>
      : <div className="easy-actions">
        <Secondary icon="stop" label={job.cancelRequested ? uiText("正在停止…") : uiText("停止存檔")} onClick={save.askStop} testId="easy-save-stop"
          disabled={job.cancelRequested} />
      </div>)}
  </Frame>;
}

export function EasySavedScreen(props: EasyScreenProps) {
  const { state, controller, canReveal } = props;
  const saved = state.saved ?? {};
  return <Frame title={uiText("影片存好了")} icon="check" tone="success" headingRef={props.headingRef} className={`easy-saved easy-result-${state.result?.orientation ?? "horizontal"}`}>
    {saved.url && <video ref={props.previewRef} className="easy-player easy-saved-player" src={saved.url} controls playsInline preload="metadata"
      aria-label={uiText("存好的影片")} data-testid="easy-saved-player" />}
    <div className="easy-saved-where" data-testid="easy-saved-where">
      {saved.inVideosFolder ? <p>{uiText("放在「影片」資料夾")}</p>
        : saved.folderName ? <p>{uiText("放在「{folder}」資料夾", { folder: saved.folderName })}</p> : null}
      {saved.fileName && <p className="easy-muted">{uiText("檔名：{name}", { name: saved.fileName })}</p>}
      {!canReveal && saved.path && <p className="easy-path">{uiText("位置：{path}", { path: saved.path })}</p>}
    </div>
    <div className="easy-cta">
      {canReveal
        ? <><Primary icon="folder-open" label={uiText("打開資料夾")} onClick={() => void controller.reveal()} testId="easy-reveal" />
          {saved.url && props.onPlaySaved && <Secondary icon="play" label={uiText("播放")} onClick={props.onPlaySaved} testId="easy-play-saved" />}
          <Secondary icon="plus" label={uiText("再做一支")} onClick={controller.startOver} testId="easy-again" /></>
        : <><Primary icon="plus" label={uiText("再做一支")} onClick={controller.startOver} testId="easy-again" />
          {saved.url && props.onPlaySaved && <Secondary icon="play" label={uiText("播放")} onClick={props.onPlaySaved} testId="easy-play-saved" />}</>}
    </div>
  </Frame>;
}

export function EasyUnavailableScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const copy = unavailableCopy(state.unavailable ?? "needs-desktop");
  return <Frame title={copy.title} lead={copy.body} icon="info" headingRef={props.headingRef} className="easy-unavailable">
    {state.video && <VideoChip video={state.video} urls={props.videoUrls} />}
    <div className="easy-cta">
      <Primary icon="scissors" label={uiText("到剪輯台自己剪")} onClick={controller.openEditor} testId="easy-edit-manually" />
    </div>
    <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="arrow-left" label={uiText("換一支影片")} onClick={controller.back} testId="easy-other-video" />
    </nav>
  </Frame>;
}

export function EasyFailedScreen(props: EasyScreenProps) {
  const { state, controller } = props;
  const kind = state.failure?.kind ?? "engine-failed";
  // Words that do not fit are fixed by changing them; footage or settings that are not allowed are not fixed by retrying.
  const fixWords = kind === "words" && state.plan?.canEditText;
  const editorOnly = kind === "not-allowed" || kind === "settings";
  return <Frame title={uiText("這次沒有剪成功")} lead={failureText(kind)} icon="alert" tone="warning"
    onBack={controller.back} headingRef={props.headingRef} className="easy-failed">
    {state.failure?.detail && <details className="easy-details"><summary>{uiText("查看原因")}</summary><p>{translateExportRefusalTextV1(state.failure.detail)}</p></details>}
    <div className="easy-cta">
      {fixWords ? <Primary icon="pencil" label={uiText("改文字")} onClick={controller.editText} testId="easy-edit-words" />
        : editorOnly ? <Primary icon="scissors" label={uiText("到剪輯台自己剪")} onClick={controller.openEditor} testId="easy-edit-manually" />
          : <Primary icon="refresh" label={uiText("再試一次")} onClick={controller.retry} testId="easy-retry" />}
    </div>
    {!editorOnly && <nav className="easy-links" aria-label={uiText("其他做法")}>
      <LinkButton icon="scissors" label={uiText("到剪輯台自己剪")} onClick={controller.openEditor} testId="easy-edit-manually" />
    </nav>}
  </Frame>;
}

export function EasyScreen(props: EasyScreenProps) {
  switch (props.state.screen) {
    case "home": return <EasyHomeScreen {...props} />;
    case "rights": return <EasyRightsScreen {...props} />;
    case "genre": return <EasyGenreScreen {...props} />;
    case "hook": return <EasyHookScreen {...props} />;
    case "title": return <EasyTitleScreen {...props} />;
    case "points": return <EasyPointsScreen {...props} />;
    case "working": return <EasyWorkingScreen {...props} />;
    case "result": return <EasyResultScreen {...props} />;
    case "saving": return <EasySavingScreen {...props} />;
    case "saved": return <EasySavedScreen {...props} />;
    case "unavailable": return <EasyUnavailableScreen {...props} />;
    case "failed": return <EasyFailedScreen {...props} />;
    default: return null;
  }
}
