/** Outside-workspace media consent (security fix 2026-10-23): the prompt shown when an opened project uses media AI agents may not read yet. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["這個專案用到工作區外的 {count} 個素材。要允許 AI 助手讀取它們嗎？（只有你在這台電腦上按允許才會生效）",
    "This project uses {count} media files outside the workspace. Allow your AI assistant to read them? (It only takes effect when you press Allow on this computer.)",
    "Este proyecto usa {count} archivos multimedia fuera del espacio de trabajo. ¿Permitir que tu asistente de IA los lea? (Solo surte efecto si pulsas Permitir en este ordenador.)",
    "このプロジェクトはワークスペース外の素材を {count} 個使っています。AI アシスタントに読み取りを許可しますか？（このパソコンで「許可」を押したときだけ有効になります）",
    "이 프로젝트는 작업 공간 밖의 미디어 {count}개를 사용해요. AI 도우미가 읽을 수 있게 허용할까요? (이 컴퓨터에서 허용을 눌러야만 적용돼요)"],
  ["允許", "Allow", "Permitir", "許可", "허용"],
  ["看是哪些檔案", "Show which files", "Ver qué archivos", "どのファイルか見る", "어떤 파일인지 보기"],
  ["沒有記錄到你的允許，請再按一次。", "Your permission wasn't saved. Please press Allow again.", "No se guardó tu permiso. Pulsa Permitir de nuevo.",
    "許可を記録できませんでした。もう一度押してください。", "허용을 기록하지 못했어요. 다시 눌러 주세요."],
];
