/**
 * Fail-closed export refusals (AREA_B audit 2026-10-23, top action 1).
 *
 * A feature that the preview shows but the selected export route would drop must stop the export with a message that
 * names the clip, the feature and what to do, instead of producing a silently different video. Each message is a
 * zh-TW interface message key with `{name}` parameters (the same convention as `t(key, params)` in src/ui); the error
 * keeps the key and the parameters so the interface can translate it, and its `message` is the filled zh-TW text that
 * MCP callers and 「查看原因」 show. Every key contains 「尚未支援」 so plain-problem classification files it under
 * "this project uses features that can't be exported together yet".
 */
export type ExportFeatureRefusalFeatureV1 =
  | "scene25d" | "particleSimulation" | "nestedScene" | "colorKeyframes" | "legacyScanlineFocus" | "trackedMask";

export const EXPORT_FEATURE_REFUSAL_CODE_V1 = "EXPORT_FEATURE_REFUSED";

/** zh-TW message keys. Parameters are filled by `fillExportRefusalMessageV1` (and by the interface's `t`). */
export const EXPORT_REFUSAL_MESSAGES_V1 = {
  scene25dNoRuntime: "2.5D 立體場景（片段「{clip}」等 {count} 個平面）需要原生 GPU 合成程式才能輸出，這次輸出沒有提供，目前尚未支援用一般合成輸出立體效果；照常輸出會變成平面畫面，所以已停止。請改用 Editkin 桌面版輸出，或在 MCP 設定原生 GPU 合成程式後再輸出。",
  scene25dVideoPlanes: "2.5D 立體場景（片段「{clip}」等 {count} 個平面）在 Rec.709 專案只能用圖片平面輸出，影片平面目前尚未支援；照常輸出會變成平面畫面，所以已停止。請把影片平面換成圖片，或把色彩管理改成 ACES 2（Rec.709 SDR）後再輸出。",
  scene25dCombination: "2.5D 立體場景（片段「{clip}」等 {count} 個平面）和這個專案的其他內容（例如字幕、動態圖文、遮罩、去背、調色、特效、關鍵幀或轉場）一起輸出目前尚未支援；照常輸出會變成平面畫面，所以已停止。請先移除這些內容，或在「立體畫面」關閉 2.5D 後再輸出。",
  scene25dColorRoute: "2.5D 立體場景（片段「{clip}」等 {count} 個平面）在目前的色彩設定（{route}）尚未支援輸出；照常輸出會變成平面畫面，所以已停止。請把輸出改成 Rec.709 或 ACES 2（Rec.709 SDR）後再輸出。",
  particlesNoRuntime: "粒子特效（{count} 個發射器）需要原生 GPU 合成程式才能輸出，這次輸出沒有提供，目前尚未支援用一般合成輸出粒子；照常輸出會少掉粒子，所以已停止。請改用 Editkin 桌面版輸出，或在 MCP 設定原生 GPU 合成程式後再輸出。",
  particlesCombination: "粒子特效（{count} 個發射器）和這個專案的其他內容（例如片段「{clip}」的影片、字幕、動態圖文、遮罩或調色）一起輸出目前尚未支援；照常輸出會少掉粒子，所以已停止。請先移除這些內容，或在「粒子特效」關閉後再輸出。",
  particlesColorRoute: "粒子特效（{count} 個發射器）在目前的色彩設定（{route}）尚未支援輸出；照常輸出會少掉粒子，所以已停止。請把輸出改成 Rec.709 或 ACES 2（Rec.709 SDR）後再輸出。",
  nestedScene: "巢狀合成「{composition}」裡的{feature}目前尚未支援輸出；照常輸出會變成平面畫面，所以已停止。請把這段內容移到根專案，或在合成裡關閉{feature}後再輸出。",
  colorKeyframesHdrExposure: "片段「{clip}」的曝光有關鍵幀動畫，但素材是 HDR（HLG／PQ）或使用線性白平衡，目前尚未支援輸出逐格曝光，照常輸出會和預覽不同，所以已停止。請移除曝光關鍵幀改用固定曝光，或改用調色節點（Color Grade v2）後再輸出。",
  colorKeyframesAdjustment: "調整圖層「{clip}」的{fields}有關鍵幀動畫，目前尚未支援輸出，照常輸出會和預覽不同，所以已停止。請把動畫移到下方的片段，或移除這些關鍵幀後再輸出。",
  colorKeyframesTooLong: "片段「{clip}」的{fields}關鍵幀動畫變化了 {frames} 格，超過輸出上限 {limit} 格，目前尚未支援這麼長的逐格調色；照常輸出會和預覽不同，所以已停止。請縮短漸變的時間，或把片段分成幾段後再輸出。",
  legacyScanlineFocus: "片段「{clip}」使用舊版特效「掃描聚焦」：預覽顯示的是對比加強，輸出卻是銳利化，兩者不一致，目前尚未支援一致的輸出，所以已停止。請在特效面板移除「掃描聚焦」後再輸出。",
  trackedMaskTooLong: "片段「{clip}」的追蹤／關鍵幀遮罩「{mask}」有 {samples} 個取樣點，超過輸出上限 {limit} 個，目前尚未支援；照常輸出會失敗或和預覽不同，所以已停止。請把片段剪短，或分段追蹤後再輸出。",
} as const;

export type ExportRefusalMessageIdV1 = keyof typeof EXPORT_REFUSAL_MESSAGES_V1;
export type ExportRefusalParamsV1 = Readonly<Record<string, string | number>>;

/** Same placeholder syntax as the interface's `t(key, params)`. Unknown placeholders are left visible. */
export function fillExportRefusalMessageV1(template: string, params: ExportRefusalParamsV1): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole);
}

/** Every zh-TW key this module can raise, for translation catalogues. */
export function exportRefusalMessageKeysV1(): string[] {
  return Object.values(EXPORT_REFUSAL_MESSAGES_V1);
}

export class ExportFeatureRefusalErrorV1 extends Error {
  override readonly name = "ExportFeatureRefusalErrorV1";
  readonly code = EXPORT_FEATURE_REFUSAL_CODE_V1;
  /** zh-TW template (interface message key). */
  readonly messageKey: string;
  constructor(readonly feature: ExportFeatureRefusalFeatureV1, readonly messageId: ExportRefusalMessageIdV1,
    readonly params: ExportRefusalParamsV1, readonly clipId?: string) {
    const messageKey = EXPORT_REFUSAL_MESSAGES_V1[messageId];
    super(`${fillExportRefusalMessageV1(messageKey, params)}（${EXPORT_FEATURE_REFUSAL_CODE_V1}/${feature}${clipId ? `/${clipId}` : ""}）`);
    this.messageKey = messageKey;
  }
}

export function isExportFeatureRefusalV1(error: unknown): error is ExportFeatureRefusalErrorV1 {
  return error instanceof ExportFeatureRefusalErrorV1;
}

/** The name the timeline shows for a clip: its media name, else its ID. */
export function exportRefusalClipLabelV1(assets: readonly { id: string; name: string }[], clip: { id: string; assetId: string }): string {
  return assets.find(asset => asset.id === clip.assetId)?.name || clip.id;
}
