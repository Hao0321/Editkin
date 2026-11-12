import { useRef } from "react";
import "./firstProjectStart.css";

interface FirstProjectStartProps {
  isDesktop: boolean;
  onImport: (files: File[]) => void;
  onDesktopImport?: () => void;
  onOpenProject?: () => void;
  onExploreDemo: () => void;
  onHelp: () => void;
  onConnectAgent?: () => void;
}

export function FirstProjectStart({ isDesktop, onImport, onDesktopImport, onOpenProject, onExploreDemo, onHelp, onConnectAgent }: FirstProjectStartProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseMedia = () => onDesktopImport ? onDesktopImport() : inputRef.current?.click();

  return (
    <section className="first-project-start" data-testid="first-project-start" aria-labelledby="first-project-title">
      <div className="first-project-glow" aria-hidden="true" />
      <div className="first-project-card">
        <div className="first-project-kicker">開始新作品</div>
        <h1 id="first-project-title">從你的素材開始，<br /><em>剪出第一版。</em></h1>
        <p>加入影片、照片或聲音，建立可編輯的時間軸。需要時再使用本機粗剪或 Agent；輸出前由你檢查畫面與節奏。</p>

        <button type="button" className="first-project-import" onClick={chooseMedia} data-testid="import-media-button" data-beginner-action="加入影片">
          <span aria-hidden="true">＋</span>
          <strong>加入影片開始剪</strong>
          <small>可一次選多個影片、照片或錄音</small>
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
        <div className="first-project-drop-hint"><span aria-hidden="true">⇣</span> 也可以直接把檔案拖到這個視窗</div>
        {isDesktop && onConnectAgent && <button type="button" className="first-project-agent" onClick={onConnectAgent} data-testid="welcome-agent-connect"><strong>了解 Agent 剪輯助理</strong><small>開啟專案後，直接在右側交代任務</small></button>}

        <ol className="first-project-steps" aria-label="開始剪輯的步驟">
          <li><b>1</b><span><strong>加入素材</strong><small>影片、照片與聲音</small></span></li>
          <li><b>2</b><span><strong>剪輯與檢查</strong><small>每個片段都能修改</small></span></li>
          <li><b>3</b><span><strong>{isDesktop ? "輸出影片" : "保存編輯資料"}</strong><small>完成前先審片</small></span></li>
        </ol>

        <div className="first-project-secondary" aria-label="其他開始方式">
          {isDesktop && onOpenProject && <button type="button" onClick={onOpenProject}>開啟之前的專案</button>}
          <button type="button" onClick={onExploreDemo} data-testid="explore-editor-button">先看看剪輯介面</button>
          <button type="button" onClick={onHelp}>看 30 秒教學</button>
        </div>
        <div className="first-project-trust"><span>✓ 素材留在本機</span><span>✓ 時間軸可逐段修改</span><span>✓ 操作可以復原</span></div>
      </div>
    </section>
  );
}
