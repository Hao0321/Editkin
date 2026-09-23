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
        <div className="first-project-kicker"><span>✦</span> 不用先學剪輯軟體</div>
        <h1 id="first-project-title">把影片丟進來，<br /><em>Editkin 幫你剪好。</em></h1>
        <p>自動判斷直式或橫式、分析畫面與語音、套用節奏、字幕、配樂與效果。完成後每一段都能自己改。</p>

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
        {isDesktop && onConnectAgent && <button type="button" className="first-project-agent" onClick={onConnectAgent} data-testid="welcome-agent-connect"><span>✦</span><strong>想讓 AI 看懂題材？連接 Codex／Claude Code</strong><small>沿用自己的訂閱 · 不用 API key</small></button>}

        <ol className="first-project-steps" aria-label="自動剪輯流程">
          <li><b>1</b><span><strong>加入影片</strong><small>自動判斷直橫與素材</small></span></li>
          <li><b>2</b><span><strong>選擇片型</strong><small>遊戲、美食、旅遊、Podcast…</small></span></li>
          <li><b>3</b><span><strong>一鍵完成</strong><small>剪完仍可拖曳微調</small></span></li>
        </ol>

        <div className="first-project-secondary" aria-label="其他開始方式">
          {isDesktop && onOpenProject && <button type="button" onClick={onOpenProject}>開啟之前的專案</button>}
          <button type="button" onClick={onExploreDemo} data-testid="explore-editor-button">先看看剪輯介面</button>
          <button type="button" onClick={onHelp}>看 30 秒教學</button>
        </div>
        <div className="first-project-trust"><span>✓ 素材留在本機</span><span>✓ 原生自動剪輯不花 AI 額度</span><span>✓ 隨時可復原</span></div>
      </div>
    </section>
  );
}
