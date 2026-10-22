import type { MotionGraphic } from "../domain/types";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";
import { requestTemplateEditor } from "./templateEditorRequests";
import { renderMotionGraphicPropertiesV1 } from "./MotionGraphicPropertiesV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";

export function renderEditingGraphicPropertiesV1({ graphic, templateId, managed = false, editScope, onTextGestureStart, onTextDraftRejected, onNumberGestureStart, onNumberDraftRejected, onChange, onDelete, onOpenSceneEditor }: {
  graphic: MotionGraphic; templateId?: string; managed?: boolean; editScope?: unknown;
  onTextGestureStart?: (graphicId: string) => ParameterGestureLeaseV1<string> | undefined;
  onTextDraftRejected?: () => void;
  onNumberGestureStart?: GraphicNumberGestureStartV1;
  onNumberDraftRejected?: () => void;
  onChange: (patch: Partial<Omit<MotionGraphic, "id" | "schema">>) => boolean | void;
  onDelete?: () => void;
  onOpenSceneEditor?: () => void;
}) {
  return <aside className="panel inspector" aria-label={t("動態圖層")} data-testid="editing-graphic-properties">
    <div className="panel-title"><h2>{graphic.name}</h2></div>
    <div className="inspector-body">
      {templateId ? <button type="button" onClick={() => requestTemplateEditor(templateId, "inspector")}>{t("編輯模板")}</button>
        : managed ? <><p>{t("此圖層由場景或模板管理，請使用對應的場景／模板編輯器。")}</p>
          {onOpenSceneEditor && <button type="button" onClick={onOpenSceneEditor}>{t("開啟場景編輯器")}</button>}</> : <>
          <label>{t("開始時間")}<NumberEditFieldV1 min="0" step="0.01" value={graphic.timelineStart} scope={editScope ?? graphic}
            onCommit={value => Number.isFinite(value) && value >= 0 ? onChange({ timelineStart: value }) : false} /></label>
          <label>{t("持續時間")}<NumberEditFieldV1 min="0.01" step="0.01" value={graphic.duration} scope={editScope ?? graphic}
            onCommit={value => Number.isFinite(value) && value > 0 ? onChange({ duration: value }) : false} /></label>
          <div className="motion-graphic-list"><div>{renderMotionGraphicPropertiesV1({ graphic, editScope, onTextGestureStart, onTextDraftRejected, onNumberGestureStart, onNumberDraftRejected,
            onUpdateMotionGraphic: (_id, patch) => onChange(patch), onDeleteMotionGraphic: () => onDelete?.(),
          })}</div></div>
        </>}
    </div>
  </aside>;
}
export function EditingGraphicPropertiesV1(props: Parameters<typeof renderEditingGraphicPropertiesV1>[0]) {
  useI18n();
  return renderEditingGraphicPropertiesV1(props);
}
