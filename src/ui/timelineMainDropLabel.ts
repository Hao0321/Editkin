import type { TimelineAssetEditMode } from "../application/timelineAssetEditDrop";
import { translateUi as uiText } from "./i18n/interfacePreferences";

/** Only the new insert/overwrite label; the old ghost geometry remains at its original call site. */
export function showTimelineMainDropLabel(ghost: HTMLElement, placement: { mode?: TimelineAssetEditMode }) {
    const label = ghost.querySelector<HTMLElement>(".timeline-asset-drop-label");
    if (placement.mode) ghost.dataset.operation = placement.mode; else delete ghost.dataset.operation;
    if (label) { label.hidden = !placement.mode; label.textContent = placement.mode ? uiText(placement.mode === "insert" ? "插入" : "覆寫") : ""; }
}
