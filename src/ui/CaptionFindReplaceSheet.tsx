import { useEffect, useRef } from "react";
import { CaptionFindReplace, type CaptionFindReplaceProps } from "./CaptionFindReplace";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";

/** Native dialog supplies focus containment and Escape; it restores the invoking control when closed. */
export function CaptionFindReplaceSheet({ onClose, ...props }: CaptionFindReplaceProps & { onClose: () => void }) {
  useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal(); element?.querySelector<HTMLInputElement>("[data-caption-search-input]")?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="caption-search-sheet" aria-label={t("尋找／取代")} onCancel={onClose}>
    <div className="caption-delivery-body">
      <button type="button" className="caption-search-close" onClick={onClose}>{t("關閉")}</button>
      <CaptionFindReplace {...props} />
    </div>
  </dialog>;
}
