import { interfacePreferences, LOCALE_NAMES, UI_LOCALES, UI_SCALES, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useRef, type ReactNode } from "react";
import { AppVersionInfo } from "./AppVersionInfo";
import "./interfaceSettings.css";

export interface InterfaceSettingsProps {
  /** The simple editor's top bar names the button 「設定」 instead of showing the language and size. */
  label?: string;
  /** More interface choices next to the language and size (the simple editor: colours and text size). */
  appearance?: ReactNode;
  /** Sections after the interface choices (the simple editor: 專案比例 and 檔案). */
  children?: ReactNode;
}

/**
 * The ⚙ settings. Everywhere: language, interface size and the 進階模式 switch. In the simple editor it is the one place
 * for everything else that is not editing: colours and text size, the project's shape, and opening or saving files.
 */
export function InterfaceSettings({ label, appearance, children }: InterfaceSettingsProps = {}) {
  const { t, locale, loadingLocale, scale, scaleBusy, mode, error } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const close = () => { if (details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } };
  // A click anywhere else closes it, like the editor's other menus, so it never stays open over the work.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const node = details.current;
      if (node?.open && event.target instanceof Node && !node.contains(event.target)) node.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const advanced = mode === "advanced";
  return <details ref={details} className="interface-settings" data-testid="interface-settings" data-variant={label ? "editor" : undefined} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <summary aria-label={t("介面設定")} title={label ? t("語言、大小、配色、專案比例、檔案和進階模式") : undefined}>
      <span aria-hidden="true">⚙</span>
      {label ? <span>{label}</span> : <><span>{LOCALE_NAMES[locale]}</span><small>{Math.round(scale * 100)}%</small></>}
    </summary>
    <div className="interface-settings-body">
      <button type="button" className="interface-settings-close" onClick={close} aria-label={t("關閉介面設定")}>×</button>
      <strong>{label ? t("設定") : t("介面設定")}</strong>
      <label>{t("介面語言")}<select data-testid="ui-language-select" value={loadingLocale ?? locale}
        onChange={event => void interfacePreferences.setLocale(event.currentTarget.value as typeof locale)}>
        {UI_LOCALES.map(item => <option key={item} value={item} lang={item}>{LOCALE_NAMES[item]}</option>)}
      </select></label>
      {loadingLocale && <p role="status">{t("正在切換語言…")}</p>}
      <label>{t("介面大小")}<select data-testid="ui-scale-select" value={scale} disabled={scaleBusy}
        onChange={event => void interfacePreferences.setScale(Number(event.currentTarget.value))}>
        {UI_SCALES.map(item => <option key={item} value={item}>{Math.round(item * 100)}%</option>)}
      </select></label>
      <button type="button" onClick={() => void interfacePreferences.setScale(1)} disabled={scaleBusy}>{t("恢復預設大小")}</button>
      {appearance}
      <p>{t("設定只影響介面，影片內容與輸出尺寸不變。")}</p>
      {children}
      <button type="button" role="switch" aria-checked={advanced} className="interface-mode-switch" data-testid="advanced-mode-switch"
        onClick={() => interfacePreferences.setMode(advanced ? "simple" : "advanced")}>
        <span className="interface-mode-switch-copy"><b>{t("進階模式")}</b><small>{t(advanced ? "關掉就回到簡單畫面" : "顯示全部專業工具")}</small></span>
        <span className="interface-mode-switch-track" aria-hidden="true"><i /></span>
      </button>
      {error && <p role="alert">{t(error)}</p>}
      <AppVersionInfo />
    </div>
  </details>;
}
