import type { MotionTrack, NormalizedRect } from "../domain/types";
import { useI18n } from "./i18n/interfacePreferences";

export function EditingTrackingToolsV1({ busy, selecting, selection, tracks, onBegin, onCorrect, onDelete, onAttach }: {
  busy: boolean; selecting: boolean; selection?: NormalizedRect; tracks: readonly MotionTrack[];
  onBegin: () => void; onCorrect: (id: string) => void; onDelete: (id: string) => void; onAttach: (id: string) => void;
}) {
  const { t } = useI18n();
  return <section className="tracking-workflow" aria-label={t("追蹤")}>
    <button type="button" className="primary-tool-action" disabled={busy} onClick={onBegin} data-testid="motion-track-button">
      {t(busy ? "正在追蹤…" : selecting ? "請在畫面框選主體" : "1. 框選主體並自動追蹤")}
    </button>
    {selection && <small>{t("已框選")} {Math.round(selection.width * 100)}% × {Math.round(selection.height * 100)}%</small>}
    {tracks.map(track => <div className="motion-track-row" key={track.id}>
      <strong>{track.name}</strong><small>{Math.round((1 - track.lostRatio) * 100)}%</small>
      <button type="button" disabled={busy} onClick={() => onAttach(track.id)}>{t("2. 綁標籤")}</button>
      <button type="button" disabled={busy} onClick={() => onCorrect(track.id)}>{t("修正此幀")}</button>
      <button type="button" disabled={busy} onClick={() => onDelete(track.id)}>{t("刪除")}</button>
    </div>)}
  </section>;
}
