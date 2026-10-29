import type { Dispatch, SetStateAction } from "react";
import type { CaptionPatch } from "../domain/commandTypes";
import type { CaptionCue, CaptionStyle } from "../domain/types";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { CaptionParameterPreviewV1 } from "../application/captionParameterGestureV1";
import { captionBackgroundOpacityV1, captionBackgroundWithOpacityV1, type CaptionEditIntentV1, type CaptionTextFieldV1 } from "../application/captionEditingActionsV1";
import { TEXT_STYLE_PRESETS } from "../creative/corePack";
import { formatTime } from "../lib/format";
import { CaptionPresetGallery } from "./PresetPreviewGallery";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";
import { TextEditFieldV1 } from "./TextEditFieldV1";
import { ParameterRangeV1 } from "./ParameterRangeV1";
import { translateUi as uiText } from "./i18n/interfacePreferences";

export interface CaptionInspectorControlsPropsV1 {
  caption: CaptionCue; captionStyle: CaptionStyle; editScope?: unknown; preview?: CaptionParameterPreviewV1;
  captionToolsOpened: boolean; setCaptionToolsOpened: Dispatch<SetStateAction<boolean>>;
  onCaptionChange: (patch: CaptionPatch, intent?: CaptionEditIntentV1) => boolean | void;
  onCaptionStyleChange: (id: string) => void;
  onCaptionStylePatch: (patch: Partial<CaptionStyle>) => boolean | void;
  onCaptionTextGestureStart?: (field: CaptionTextFieldV1) => ParameterGestureLeaseV1<string> | undefined;
  onCaptionOpacityGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  onCaptionDraftRejected?: () => void;
}
/** Existing caption UI and presets, with drafts owned by the original project command adapters. */
export function CaptionInspectorControlsV1({ caption, captionStyle, editScope, preview, captionToolsOpened, setCaptionToolsOpened,
  onCaptionChange, onCaptionStyleChange, onCaptionStylePatch, onCaptionTextGestureStart, onCaptionOpacityGestureStart, onCaptionDraftRejected }: CaptionInspectorControlsPropsV1) {
  const currentPreview = preview?.captionId === caption.id ? preview : undefined;
  const visibleCaption = currentPreview?.project.captions.find(c => c.id === caption.id) ?? caption;
  const visibleStyle = currentPreview?.project.captionStyle ?? captionStyle, isEditing = true;
  return (<div className="inspector-body" data-testid="caption-inspector">
          <div className="selected-card">
            <div className="selected-icon">T</div>
            <div><strong>{visibleCaption.text}</strong><span>{uiText("字幕 · ")}{formatTime(caption.duration)}</span></div>
          </div>
          <label className="field-label">{uiText("第一行 · 原文")}<TextEditFieldV1 multiline value={caption.text} scope={editScope ?? caption} onCommit={value => onCaptionChange({ text: value })} onGestureStart={onCaptionTextGestureStart ? () => onCaptionTextGestureStart("text") : undefined} onReject={onCaptionDraftRejected} data-testid="caption-text-input" />
          </label>
          {caption.translation ? <div className="caption-translation-editor" data-testid="caption-translation-editor">
            <label className="field-label">{uiText("第二行 · ")}{caption.translation.language === "en" ? uiText("英文翻譯") : caption.translation.language}
              <TextEditFieldV1 multiline value={caption.translation.text} scope={editScope ?? caption} onCommit={value => onCaptionChange({ translation: { ...caption.translation!, text: value } }, "translation-text")} onGestureStart={onCaptionTextGestureStart ? () => onCaptionTextGestureStart("translation") : undefined} onReject={onCaptionDraftRejected} data-testid="caption-translation-input" />
            </label>
            <button type="button" onClick={() => onCaptionChange({ translation: null })}>{uiText("改回單語字幕")}</button>
          </div> : <p className="caption-bilingual-hint">{uiText("需要雙語？在「更多一鍵功能 → 字幕類型」選擇「原文＋英文雙語」。")}</p>}
          <button type="button" className="preview-center-entry caption" onClick={() => setCaptionToolsOpened(true)} data-testid="caption-preview-entry"><span aria-hidden="true"><i>{uiText("字")}</i><i>Aa</i><i>{uiText("黑底")}</i></span><b><strong>{uiText("打開字幕樣式預覽")}</strong><small>{uiText("字型、顏色、描邊、半透明黑底都能直接看")}</small></b><em>{uiText("查看 →")}</em></button>
          <details className="inspector-section" data-testid="caption-advanced" open={captionToolsOpened}>
            <summary onClick={(event) => { event.preventDefault(); setCaptionToolsOpened((opened) => !opened); }}>{uiText("更多字幕設定 ")}<small>{uiText("風格、字型、時間")}</small></summary>
            <div className="inspector-advanced-body">
              <label className="field-label">{uiText("文字風格")}<select className="visually-hidden" value={captionStyle.presetId} onChange={(event) => onCaptionStyleChange(event.target.value)} data-testid="text-style-select">
                  {TEXT_STYLE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{uiText(preset.name)}</option>)}
                </select>
                <CaptionPresetGallery selected={captionStyle.presetId} onSelect={onCaptionStyleChange} />
              </label>
              <label className="field-label">{uiText("內建開源字型")}<select value={captionStyle.fontFamily} onChange={(event) => onCaptionStylePatch({ fontFamily: event.target.value })} data-testid="font-family-select"><option value="Noto Sans TC">{uiText("Noto Sans TC · 繁中主字型")}</option><option value="Noto Serif TC">{uiText("Noto Serif TC · 雜誌襯線")}</option><option value="LXGW WenKai Mono TC">{uiText("霞鶩文楷 Mono TC")}</option><option value="LXGW WenKai TC">{uiText("霞鶩文楷 TC · 旅遊手寫粗體")}</option><option value="Bebas Neue">{uiText("Bebas Neue · 英文標題")}</option><option value="Fredoka">{uiText("Fredoka · 活潑字卡")}</option></select>
              </label>
              <div className="caption-emphasis-row"><label><input type="checkbox" checked={captionStyle.bold} onChange={(event) => onCaptionStylePatch({ bold: event.target.checked })} />{uiText(" 粗體")}</label><label><input type="checkbox" checked={captionStyle.italic} onChange={(event) => onCaptionStylePatch({ italic: event.target.checked })} />{uiText(" 斜體")}</label></div>
              <div className="field-label">{uiText("字幕顏色與底色")}<div className="caption-color-grid"><label>{uiText("文字色 ")}<input type="color" value={captionStyle.color.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ color: event.target.value.toUpperCase() })} /></label><label>{uiText("描邊色 ")}<input type="color" value={captionStyle.outlineColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ outlineColor: event.target.value.toUpperCase() })} /></label><label>{uiText("底色 ")}<input type="color" value={captionStyle.backgroundColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ backgroundColor: `${event.target.value.toUpperCase()}${captionStyle.backgroundColor.slice(7, 9) || "99"}` })} /></label><label>{uiText("字級 ")}<NumberEditFieldV1 min="18" max="160" value={captionStyle.fontSize} scope={editScope ?? caption} onCommit={value => onCaptionStylePatch({ fontSize: value })} /></label></div>
                <div className="caption-background-presets" aria-label={uiText("字幕半透明背景")}><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#00000000" })}>{uiText("無底色")}</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#00000066" })}>{uiText("黑底 40%")}</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#000000A6" })}>{uiText("黑底 65%")}</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#000000CC" })}>{uiText("黑底 80%")}</button></div>
                <label className="caption-opacity">{uiText("底色透明度 ")}<ParameterRangeV1 min="0" max="100" scopeKey={`caption:${caption.id}:background`} value={Math.round(captionBackgroundOpacityV1(visibleStyle.backgroundColor))} onGestureStart={onCaptionOpacityGestureStart} onChange={value => onCaptionStylePatch({ backgroundColor: captionBackgroundWithOpacityV1(captionStyle.backgroundColor, value) })} /><span>{Math.round(captionBackgroundOpacityV1(visibleStyle.backgroundColor))}%</span></label>
              </div>
              {caption.translation && <div className="caption-translation-style" data-testid="caption-translation-style">
                <strong>{uiText("第二行翻譯樣式")}</strong>
                <label className="field-label">{uiText("翻譯字型")}<select value={captionStyle.translationFontFamily} onChange={(event) => onCaptionStylePatch({ translationFontFamily: event.target.value })} data-testid="translation-font-family-select"><option value="Noto Sans TC">{uiText("Noto Sans TC · 清楚易讀")}</option><option value="Noto Serif TC">{uiText("Noto Serif TC · 雜誌襯線")}</option><option value="LXGW WenKai Mono TC">{uiText("霞鶩文楷 Mono TC")}</option><option value="LXGW WenKai TC">{uiText("霞鶩文楷 TC · 旅遊手寫粗體")}</option><option value="Bebas Neue">{uiText("Bebas Neue · 英文標題")}</option><option value="Fredoka">{uiText("Fredoka · 活潑圓體")}</option></select>
                </label>
                <div className="caption-color-grid"><label>{uiText("翻譯色 ")}<input type="color" value={captionStyle.translationColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ translationColor: event.target.value.toUpperCase() })} /></label><label>{uiText("翻譯字級 ")}<NumberEditFieldV1 min="14" max="140" value={captionStyle.translationFontSize} scope={editScope ?? caption} onCommit={value => onCaptionStylePatch({ translationFontSize: value })} /></label></div>
                <div className="caption-emphasis-row"><label><input type="checkbox" checked={captionStyle.translationBold} onChange={(event) => onCaptionStylePatch({ translationBold: event.target.checked })} />{uiText(" 翻譯粗體")}</label><label><input type="checkbox" checked={captionStyle.translationItalic} onChange={(event) => onCaptionStylePatch({ translationItalic: event.target.checked })} />{uiText(" 翻譯斜體")}</label></div>
              </div>}
              <label className="field-label">{uiText("從第幾秒出現")}<div className="number-field"><NumberEditFieldV1 min="0" step="0.1" value={caption.start} scope={editScope ?? caption} onCommit={value => onCaptionChange({ start: value })} /><span>sec</span></div>
              </label>
              <label className="field-label">{uiText("顯示多久")}<div className="number-field"><NumberEditFieldV1 min="0.1" step="0.1" value={caption.duration} scope={editScope ?? caption} onCommit={value => onCaptionChange({ duration: value })} /><span>sec</span></div>
              </label>
              {isEditing && <div className="metric-grid"><div><span>{uiText("結束時間")}</span><strong>{formatTime(caption.start + caption.duration)}</strong></div><div><span>{uiText("輸出方式")}</span><strong>{uiText("直接燒錄")}</strong></div></div>}
            </div>
          </details>
        </div>);
}

