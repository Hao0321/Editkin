import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import { BeginnerShortcutSheet } from "./BeginnerShortcuts";
import "./beginnerGuide.css";
import "./beginnerShortcuts.css";

/** Which page the guide opens on: the four steps (說明) or the 快捷鍵 page ("?"). */
export type BeginnerGuidePage = "steps" | "shortcuts";
interface BeginnerGuideProps { onClose: () => void; onChooseMedia: () => void; initialPage?: BeginnerGuidePage; }
export const STEPS = [
  { title: "加入你拍的影片", body: "選影片、照片或聲音，也能一次選多個。", visual: "＋" },
  { title: "剪掉不要的部分", body: "按 B 換成剪刀，在片段上點一下就切開；選取片段按 Delete 刪除；按復原可以回到上一步。", visual: "✂" },
  { title: "播放一次，確認結果", body: "按播放看畫面與聲音，直接修改字幕或調整片段。", visual: "▶" },
  { title: "儲存專案，再輸出影片", body: "專案檔可繼續編輯；輸出的影片可播放與分享。網頁版可下載專案。", visual: "↑" },
] as const;

export function BeginnerGuide({ onClose, onChooseMedia, initialPage = "steps" }: BeginnerGuideProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  // The 快捷鍵 page: every key in big plain words (說明 opens the steps, then its tab; "?" opens it directly).
  const [shortcuts, setShortcuts] = useState(initialPage === "shortcuts");
  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const current = STEPS[step];
  return <dialog ref={dialog} className="beginner-guide" aria-labelledby="beginner-guide-title" data-testid="beginner-guide"
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <button type="button" className="guide-close" onClick={onClose} aria-label={t("關閉教學")}>×</button>
    <header><span>{t("快速教學")}</span><h2 id="beginner-guide-title">{t("四步完成影片")}</h2><p>{t("不用記快捷鍵，按畫面上的按鈕即可。")}</p></header>
    <div className="guide-progress" aria-label={t("第 {step} 步，共 {total} 步", { step: step + 1, total: STEPS.length })}>
      {STEPS.map((item, index) => <button type="button" key={item.title} className={!shortcuts && index === step ? "active" : ""}
        onClick={() => { setStep(index); setShortcuts(false); }} aria-current={!shortcuts && index === step ? "step" : undefined} aria-label={t("前往第 {step} 步", { step: index + 1 })}>{index + 1}</button>)}
      <button type="button" className={shortcuts ? "guide-shortcuts-tab active" : "guide-shortcuts-tab"} aria-pressed={shortcuts}
        onClick={() => setShortcuts(true)} data-testid="guide-shortcuts-tab">{t("快捷鍵")}</button>
    </div>
    {shortcuts ? <BeginnerShortcutSheet /> : <div className="guide-card"><div className={`guide-visual guide-visual-${step + 1}`} aria-hidden="true"><b>{current.visual}</b></div>
      <div><span>{t("步驟 {step}", { step: step + 1 })}</span><h3>{t(current.title)}</h3><p>{t(current.body)}</p></div></div>}
    <footer><button type="button" className="guide-skip" onClick={onClose} data-testid="guide-skip">{t("開始剪輯")}</button><div>
      {!shortcuts && step > 0 && <button type="button" className="guide-back" onClick={() => setStep(step - 1)}>{t("上一步")}</button>}
      {!shortcuts && step < STEPS.length - 1 && <button type="button" className="guide-back" onClick={() => setStep(step + 1)}>{t("下一步")}</button>}
      <button type="button" className="guide-next" data-testid="guide-choose-media" onClick={() => { onClose(); window.setTimeout(onChooseMedia, 0); }}>{t("加入影片")}</button>
    </div></footer>
  </dialog>;
}
