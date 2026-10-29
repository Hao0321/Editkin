import { useRef } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import { EasyFlow, EasyFlowDemo } from "./easy/EasyFlow";
import { readEasyDemoSwitch, type EasyFlowHost } from "./easy/easyFlowHost";
import { AgentHelpCardLive } from "./agentConnect/AgentHelpEntryV1";
import "./firstProjectStart.css";

interface FirstProjectStartProps {
  isDesktop: boolean;
  onImport: (files: File[]) => void;
  onDesktopImport?: () => void;
  onOpenProject?: () => void;
  onExploreDemo: () => void;
  onHelp: () => void;
  onConnectAgent?: () => void;
  /** Simple mode starts with the easy flow when the editor shell provides its host. */
  easyFlowHost?: EasyFlowHost;
}

/** The welcome card's step strip: the editor's three steps (interfaceMessages.70: 三步完成影片). */
export const FIRST_PROJECT_STEPS = ["加入影片", "剪輯", "輸出"] as const;

export function FirstProjectStart({ isDesktop, onImport, onDesktopImport, onOpenProject, onExploreDemo, onHelp, onConnectAgent, easyFlowHost }: FirstProjectStartProps) {
  const { t, mode } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseMedia = () => onDesktopImport ? onDesktopImport() : inputRef.current?.click();
  if (mode === "simple") {
    // Dev-only simulation for screenshots and review; production builds never read the switch.
    const demo = readEasyDemoSwitch();
    if (demo) return <EasyFlowDemo demo={demo} onWorkspace={onExploreDemo} onOpenProject={() => onOpenProject?.()} />;
    // The desktop's 讓 AI 幫我剪片 is in plain sight in simple mode too (the release notes point at the start screen).
    if (easyFlowHost) return <EasyFlow host={easyFlowHost} onConnectAgent={isDesktop ? onConnectAgent : undefined} />;
  }

  return (
    <section className="first-project-start" data-testid="first-project-start" aria-labelledby="first-project-title">
      <div className="first-project-glow" aria-hidden="true" />
      <div className="first-project-card">
        <div className="first-project-kicker"><span aria-hidden="true">✦</span>{t("從一支影片開始")}</div>
        <h1 id="first-project-title">{t("加入影片，開始剪輯")}</h1>
        <p>{t("先選影片，再選擇自己調整或製作第一版粗剪。每一步都能復原。")}</p>

        <button type="button" className="first-project-import" onClick={chooseMedia} data-testid="import-media-button" data-beginner-action="加入影片">
          <span aria-hidden="true">＋</span>
          <strong>{t("加入影片")}</strong>
          <small>{t("可一次選多個影片、照片或錄音")}</small>
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          data-testid="media-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) onImport(files);
            event.currentTarget.value = "";
          }}
        />
        <div className="first-project-drop-hint"><span aria-hidden="true">⇣</span>{t("也可以直接把檔案拖到這個視窗")}</div>

        {/* The same three steps as the editor's step strip (加入影片 → 剪輯 → 輸出); there is no separate 檢查 step any more. */}
        <ol className="first-project-steps" aria-label={t("三步完成影片")}>
          {FIRST_PROJECT_STEPS.map((label, index) => <li key={label}><b aria-hidden="true">{index + 1}</b><span><strong>{t(label)}</strong></span></li>)}
        </ol>

        <div className="first-project-secondary" aria-label={t("如何開始")}>
          {onOpenProject && <button type="button" onClick={onOpenProject} data-testid="welcome-open-project">{t("開啟之前的專案")}</button>}
          <button type="button" onClick={onExploreDemo} data-testid="explore-editor-button">{t("先看看剪輯介面")}</button>
          <button type="button" onClick={onHelp}>{t("快速教學")}</button>
        </div>
        {/* The same 「讓 AI 幫我剪片」 card as the simple start and the simple top bar (2026-10-29). */}
        {isDesktop && onConnectAgent && <div className="first-project-agent"><AgentHelpCardLive onClick={onConnectAgent} /></div>}
        <div className="first-project-trust"><span>✓ {t("原始檔案不會被剪掉")}</span><span>✓ {t("隨時可復原")}</span></div>
      </div>
    </section>
  );
}
