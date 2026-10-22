import { useRef } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import { EasyFlow, EasyFlowDemo } from "./easy/EasyFlow";
import { readEasyDemoSwitch, type EasyFlowHost } from "./easy/easyFlowHost";
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

export function FirstProjectStart({ isDesktop, onImport, onDesktopImport, onOpenProject, onExploreDemo, onHelp, onConnectAgent, easyFlowHost }: FirstProjectStartProps) {
  const { t, mode } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseMedia = () => onDesktopImport ? onDesktopImport() : inputRef.current?.click();
  if (mode === "simple") {
    // Dev-only simulation for screenshots and review; production builds never read the switch.
    const demo = readEasyDemoSwitch();
    if (demo) return <EasyFlowDemo demo={demo} onWorkspace={onExploreDemo} onOpenProject={() => onOpenProject?.()} />;
    if (easyFlowHost) return <EasyFlow host={easyFlowHost} />;
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

        <ol className="first-project-steps" aria-label={t("四步完成影片")}>
          {["加入影片", "剪輯", "檢查", "輸出"].map((label, index) => <li key={label}><b aria-hidden="true">{index + 1}</b><span><strong>{t(label)}</strong></span></li>)}
        </ol>

        <div className="first-project-secondary" aria-label={t("如何開始")}>
          {onOpenProject && <button type="button" onClick={onOpenProject} data-testid="welcome-open-project">{t("開啟之前的專案")}</button>}
          <button type="button" onClick={onExploreDemo} data-testid="explore-editor-button">{t("先看看剪輯介面")}</button>
          <button type="button" onClick={onHelp}>{t("快速教學")}</button>
        </div>
        {isDesktop && onConnectAgent && <details className="first-project-ai"><summary>{t("AI 協助剪輯")}</summary><p>{t("連接 Codex 或 Claude 後，再由你決定 AI 要做什麼。")}</p><button type="button" onClick={onConnectAgent} data-testid="welcome-agent-connect">{t("連接 AI 助手")}</button></details>}
        <div className="first-project-trust"><span>✓ {t("原始檔案不會被剪掉")}</span><span>✓ {t("隨時可復原")}</span></div>
      </div>
    </section>
  );
}
