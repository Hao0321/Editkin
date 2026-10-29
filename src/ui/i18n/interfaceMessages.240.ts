/** W2-4 (2026-10-23): simple mode's 「好了，存成影片」 as an export job: stop question, stop/keep buttons, the saved player. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["停止存檔", "Stop saving", "Detener el guardado", "保存を止める", "저장 멈추기"],
  ["繼續存", "Keep saving", "Seguir guardando", "保存を続ける", "계속 저장하기"],
  ["要停止存檔嗎？影片不會存下來，剪好的內容還在。", "Stop saving? The video won't be saved, but your edit is still here.", "¿Detener el guardado? El vídeo no se guardará, pero tu edición sigue aquí.", "保存を止めますか？動画は保存されませんが、編集した内容は残ります。", "저장을 멈출까요? 영상은 저장되지 않지만 편집한 내용은 그대로 있어요."],
  ["存好的影片", "Saved video", "Vídeo guardado", "保存した動画", "저장한 영상"],
  ["已經有一支影片正在輸出，請等它做完再存。", "Another video is already being exported. Save again when it finishes.", "Ya se está exportando otro vídeo. Vuelve a guardar cuando termine.", "別の動画を書き出し中です。終わってから保存してください。", "다른 영상을 내보내는 중이에요. 끝난 뒤에 저장해 주세요."],
];
