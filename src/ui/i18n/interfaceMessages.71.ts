/** Transitional admission for persisted mixed-order projects until every preview/export consumer is connected. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["此專案的混合圖層排序目前無法預覽。", "This project's mixed layer order cannot be previewed yet.", "El orden mixto de capas de este proyecto aún no se puede previsualizar.", "このプロジェクトの混合レイヤー順序はまだプレビューできません。", "이 프로젝트의 혼합 레이어 순서는 아직 미리 볼 수 없어요."],
  ["為保留正確圖層順序，已暫停顯示畫面。", "The picture is paused to preserve the correct layer order.", "La imagen está pausada para conservar el orden correcto de las capas.", "正しいレイヤー順序を維持するため、映像表示を停止しています。", "올바른 레이어 순서를 유지하기 위해 화면 표시를 중지했어요."],
  ["此專案的混合圖層排序尚未支援正式輸出；已停止輸出，避免圖層順序改變。", "Export does not yet support this project's mixed layer order. Export stopped to preserve the order.", "La exportación aún no admite el orden mixto de capas de este proyecto. Se detuvo para conservarlo.", "このプロジェクトの混合レイヤー順序はまだ書き出せません。順序を維持するため書き出しを停止しました。", "이 프로젝트의 혼합 레이어 순서는 아직 내보낼 수 없어요. 순서를 유지하기 위해 내보내기를 중지했어요."],
];
