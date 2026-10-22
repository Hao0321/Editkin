import type { AutoReframeLabelsV1 } from "./AutoReframeButtonV1";
export function autoReframeLabelsV1(t: (text: string, values?: Readonly<Record<string, string | number>>) => string): AutoReframeLabelsV1 {
  return {
    title:t("自動直式重構圖"), current:t("套用到目前直式專案"), newProject:t("建立另一個直式專案"), analyze:t("分析原片構圖"), apply:t("套用構圖，可復原"), create:t("建立直式版本"), cancel:t("取消"),
    idle:t("選擇方式後，先分析再預覽裁切路徑。"), preparing:t("正在準備原片…"), analyzing:t("正在分析構圖，可隨時取消…"), applying:t("正在套用構圖…"), done:t("構圖已套用。"), candidate:t("已產生構圖草稿；確認路徑後再套用。"),
    graph:t("原片內的裁切框與移動路徑"), confirmedSubject:t("追蹤已確認的主體；主體遺失時不改追其他物體。"), saliencySubject:t("依畫面顯著位置構圖，不代表已辨識或確認人物。"),
    help:t("分析使用原片；不下載模型、不改寫影片。請先檢查裁切路徑。"), unknownCoverage:t("目前無法估計主體涵蓋率。"), crop:t("直式裁切範圍"), startPoint:t("路徑起點"), endPoint:t("路徑終點"),
    locked:t("這個軌道已鎖定，先解鎖才能修改。"), camera:t("這個片段含鏡頭設定，請先移除再重構圖。"), dependency:t("這個片段的相依內容尚不支援重構圖。"), source:t("原片或來源指紋尚未準備好，請先完成素材準備。"),
    stale:t("專案已變更，請重新分析構圖。"), subjectChanged:t("主體確認已變更，請重新分析。"), unavailable:t("這個環境還不能分析重構圖。"), failed:t("無法完成構圖分析；原專案未變更。"),
    stage:{verify:t("核對原片"),matte:t("讀取已確認主體"),source:t("分析原片影格"),finalize:t("整理裁切路徑")},
    coverage:(percent,valid,unknown)=>t("主體涵蓋 {percent}；有效 {valid} 格、未知 {unknown} 格。",{percent,valid,unknown}),
    preserved:(audio,captions,masks)=>t("保留 {audio} 段連動聲音、{captions} 段字幕與 {masks} 個遮罩。",{audio,captions,masks}),
    newProjectName:sourceName=>t("{name}・直式版本",{name:sourceName}),
  };
}
