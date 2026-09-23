import { useState } from "react";
import "./beginnerGuide.css";
import "./beginnerShortcuts.css";

interface BeginnerGuideProps {
  onClose: () => void;
  onChooseMedia: () => void;
}

const STEPS = [
  {
    number: "1",
    title: "先放進你拍的原始影片",
    body: "按中央的「加入影片開始剪」，可以一次選影片、照片和聲音。直式或橫式會自動判斷，不用先設定尺寸。",
    visual: "＋",
  },
  {
    number: "2",
    title: "告訴它這支影片是哪一型",
    body: "選遊戲、美食、旅遊、Podcast 或讓 Editkin 自己判斷。片型會決定節奏、字幕、音樂與效果的取捨。",
    visual: "遊戲 · 美食 · 旅遊 · Podcast",
  },
  {
    number: "3",
    title: "按「一鍵自動完成」",
    body: "它會分析畫面與語音，剪停頓、切場景、做字幕，並在適合時套用配樂、調色、轉場、特效與追蹤。",
    visual: "✦ 一鍵自動完成",
  },
  {
    number: "4",
    title: "不滿意就直接拖、改、刪",
    body: "成品仍是完整可編輯 Timeline。拖片段、改字幕或刪除都能復原；完成後按右上角「輸出影片」。",
    visual: "拖曳微調 → 輸出影片",
  },
] as const;

export function BeginnerGuide({ onClose, onChooseMedia }: BeginnerGuideProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const finish = (chooseMedia: boolean) => {
    onClose();
    if (chooseMedia) window.setTimeout(onChooseMedia, 0);
  };
  return <div className="beginner-guide-backdrop" role="presentation">
    <section className="beginner-guide" role="dialog" aria-modal="true" aria-labelledby="beginner-guide-title" data-testid="beginner-guide">
      <button type="button" className="guide-close" onClick={() => finish(false)} aria-label="關閉新手教學">×</button>
      <header>
        <span>第一次用剪輯軟體也沒問題</span>
        <h2 id="beginner-guide-title">四步完成第一支影片</h2>
        <p>不用先學 Timeline，也不用串 API。</p>
      </header>
      <div className="guide-progress" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>
        {STEPS.map((item, index) => <button type="button" key={item.number} className={index === step ? "active" : index < step ? "done" : ""} onClick={() => setStep(index)} aria-label={`前往第 ${item.number} 步`}>{index < step ? "✓" : item.number}</button>)}
      </div>
      <div className="guide-card">
        <div className={`guide-visual guide-visual-${step + 1}`} aria-hidden="true"><b>{current.visual}</b></div>
        <div><span>步驟 {current.number}</span><h3>{current.title}</h3><p>{current.body}</p></div>
      </div>
      {step === 3 && <div className="guide-shortcuts" aria-label="常用快捷鍵">
        <span><kbd>Space</kbd> 播放</span><span><kbd>B</kbd> 切開</span><span><kbd>Delete</kbd> 刪除補空隙</span><span><kbd>Ctrl Z</kbd> 復原</span>
      </div>}
      <footer>
        <button type="button" className="guide-skip" onClick={() => finish(false)} data-testid="guide-skip">先自己試試看</button>
        <div>
          {step > 0 && <button type="button" className="guide-back" onClick={() => setStep((value) => value - 1)}>上一步</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="guide-next" onClick={() => setStep((value) => value + 1)}>下一步</button>
            : <button type="button" className="guide-next" onClick={() => finish(true)} data-testid="guide-choose-media">開始選影片</button>}
        </div>
      </footer>
    </section>
  </div>;
}
