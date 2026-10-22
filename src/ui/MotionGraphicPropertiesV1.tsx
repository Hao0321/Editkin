import type { MotionGraphic } from "../domain/types";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import { motionDesignV3FieldHint } from "../creative/motionDesignV3Presets";
import { MOTION_DESIGN_V3_FIELDS } from "../domain/motionCompositionV3Contract";
import { formatTime } from "../lib/format";
import { bundledFontFamilies, resolveBundledFontFace } from "../typography/fontFaces";
import { requestTemplateEditor } from "./templateEditorRequests";
import MotionVectorControls from "./MotionVectorControls";
import MotionTextLayoutControls from "./MotionTextLayoutControls";
import { TextEditFieldV1 } from "./TextEditFieldV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";

const fontFamilies = bundledFontFamilies();

/** Shared controls preserve the Motion library's existing fields and canonical callbacks.
 * The caller subscribes to locale changes; this pure view is also used by layer properties. */
export function renderMotionGraphicPropertiesV1({ graphic, managedMotionGraphicIds = [], templateOwners,
  showTemplateHint = true, editScope, onTextGestureStart, onTextDraftRejected, onNumberGestureStart, onNumberDraftRejected, onUpdateMotionGraphic, onDeleteMotionGraphic }: {
  graphic: MotionGraphic;
  managedMotionGraphicIds?: readonly string[];
  templateOwners?: Readonly<Record<string, { instanceId: string; title: string }>>;
  showTemplateHint?: boolean;
  editScope?: unknown;
  onTextGestureStart?: (graphicId: string) => ParameterGestureLeaseV1<string> | undefined;
  onTextDraftRejected?: () => void;
  onNumberGestureStart?: GraphicNumberGestureStartV1;
  onNumberDraftRejected?: () => void;
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => boolean | void;
  onDeleteMotionGraphic: (graphicId: string) => void;
}) {
  return <>
        {graphic.schema === "hao.motion-composition/v3" && graphic.designV3 ? <TextEditFieldV1 multiline value={graphic.text} scope={editScope ?? graphic} disabled={managedMotionGraphicIds.includes(graphic.id)} aria-label={uiText("{value0}文字", { value0: String(graphic.name) })} rows={MOTION_DESIGN_V3_FIELDS[graphic.designV3.template].length}
            placeholder={motionDesignV3FieldHint(MOTION_DESIGN_V3_FIELDS[graphic.designV3.template])} title={motionDesignV3FieldHint(MOTION_DESIGN_V3_FIELDS[graphic.designV3.template])}
            onGestureStart={onTextGestureStart ? () => managedMotionGraphicIds.includes(graphic.id) ? undefined : onTextGestureStart(graphic.id) : undefined} onReject={onTextDraftRejected}
            onCommit={value => managedMotionGraphicIds.includes(graphic.id) ? false : onUpdateMotionGraphic(graphic.id, { text: value })} /> : !graphic.vectorV2 && <TextEditFieldV1 value={graphic.text} scope={editScope ?? graphic} disabled={managedMotionGraphicIds.includes(graphic.id)} aria-label={uiText("{value0}文字", { value0: String(graphic.name) })}
            onGestureStart={onTextGestureStart ? () => managedMotionGraphicIds.includes(graphic.id) ? undefined : onTextGestureStart(graphic.id) : undefined} onReject={onTextDraftRejected}
            onCommit={value => managedMotionGraphicIds.includes(graphic.id) ? false : onUpdateMotionGraphic(graphic.id, { text: value })} />}
        {managedMotionGraphicIds.includes(graphic.id) && (templateOwners?.[graphic.id]
          ? showTemplateHint
            ? <button type="button" className="motion-open-template" data-testid={`motion-open-template-${graphic.id}`}
              onClick={() => requestTemplateEditor(templateOwners[graphic.id].instanceId, "motion-studio")}>
              {uiText("這是標題模板「{title}」的文字 · 打開模板編輯器修改", { title: templateOwners[graphic.id].title })}</button>
            : <small>{uiText("屬於標題模板「{title}」", { title: templateOwners[graphic.id].title })}</small>
          : <small>{uiText("此圖層由場景或模板管理，請使用對應的場景／模板編輯器。")}</small>)}
        <span>{formatTime(graphic.timelineStart)} · {graphic.name}{graphic.visualStyle && graphic.visualStyle !== "solid_panel" ? ` · ${graphic.visualStyle}` : ""}</span>
        {!graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">{uiText("字型")}<select aria-label={uiText("{value0}字型", { value0: graphic.name })} value={graphic.fontFamily ?? "Noto Sans TC"} onChange={event => {
            const fontFamily = event.target.value;
            const face = resolveBundledFontFace(fontFamily, Math.min(900, Math.max(100, graphic.fontWeight ?? 700)));
            if (face) onUpdateMotionGraphic(graphic.id, { fontFamily, fontWeight: face.fontWeight });
          }}>
            {graphic.fontFamily && !fontFamilies.includes(graphic.fontFamily) && <option value={graphic.fontFamily} disabled>{graphic.fontFamily}{uiText("（未驗證字型）")}</option>}
            {fontFamilies.map(family => <option key={family} value={family}>{family}{family === "Bebas Neue" || family === "Fredoka" ? uiText(" · 英文／數字") : ""}</option>)}
          </select>
        </label>}
        {graphic.schema === "hao.motion-composition/v2" && !graphic.vectorV2 && !graphic.trackId && !managedMotionGraphicIds.includes(graphic.id) && <MotionTextLayoutControls graphic={graphic} editScope={editScope} onNumberGestureStart={onNumberGestureStart} onNumberDraftRejected={onNumberDraftRejected} onUpdate={patch => onUpdateMotionGraphic(graphic.id, patch)} />}
        {graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <MotionVectorControls graphic={graphic} editScope={editScope} onNumberGestureStart={onNumberGestureStart} onNumberDraftRejected={onNumberDraftRejected} onUpdate={patch => onUpdateMotionGraphic(graphic.id, patch)} />}
        {graphic.schema === "hao.motion-composition/v2" && graphic.vectorV2 && graphic.vectorV2.kind !== "spring_panel" && graphic.vectorV2.kind !== "shape" && graphic.vectorV2.kind !== "stroke" && !graphic.text && !graphic.trackId && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">{uiText("合成位置")}<select aria-label={uiText("{value0}合成位置", { value0: graphic.name })} value={graphic.vectorV2.schema === "editkin.motion-vector-annotation/v1" ? "annotation" : graphic.compositeLayer ?? "foreground"} onChange={event => {
            const vector = graphic.vectorV2;
            if (!vector || vector.kind === "spring_panel" || vector.kind === "shape" || vector.kind === "stroke") return;
            if (event.target.value === "annotation") {
              if (vector.kind !== "rule") return;
              onUpdateMotionGraphic(graphic.id, { compositeLayer: "foreground", vectorV2: { ...vector, schema: "editkin.motion-vector-annotation/v1", kind: "rule" } });
              return;
            }
            onUpdateMotionGraphic(graphic.id, { compositeLayer: event.target.value as "background" | "foreground", vectorV2: { ...vector, schema: "editkin.motion-vector-stage/v1" } });
          }}>
            <option value="foreground">{uiText("素材前方")}</option><option value="background">{uiText("素材後方")}</option>
            {graphic.vectorV2.kind === "rule" && <option value="annotation">{uiText("文字上方")}</option>}
          </select>
        </label>}
        {graphic.schema === "hao.motion-composition/v2" && graphic.layoutV2 && !graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">{uiText("底框")}<select aria-label={uiText("{value0}底框寬度", { value0: graphic.name })} value={graphic.layoutV2.widthMode ?? "fixed"} onChange={(event) => onUpdateMotionGraphic(graphic.id, { layoutV2: { ...graphic.layoutV2!, widthMode: event.target.value as "fixed" | "fit_content" } })}>
            <option value="fixed">{uiText("固定寬度")}</option><option value="fit_content">{uiText("貼合文字")}</option>
          </select>
        </label>}
        <button type="button" disabled={managedMotionGraphicIds.includes(graphic.id)} aria-label={uiText("刪除{value0}", { value0: graphic.name })} onClick={() => {
          if (!managedMotionGraphicIds.includes(graphic.id)) onDeleteMotionGraphic(graphic.id);
        }}>×</button>
  </>;
}
