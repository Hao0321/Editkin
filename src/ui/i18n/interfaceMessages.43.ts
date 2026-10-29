/** W1-8 current-frame Primary + v2 in-app grade clipboard, explicit temporal semantics. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["複製與貼上調色", "Copy and paste grade", "Copiar y pegar ajustes de color", "調色のコピーと貼り付け", "색보정 복사 및 붙여넣기"],
  ["複製目前影格的 Primary＋v2，僅在同一專案內使用。", "Copy this frame's Primary + v2 grade for use within this project.", "Copie Primary + v2 del fotograma actual para usarlo en este proyecto.", "現在のフレームの Primary＋v2 調色を、このプロジェクト内でコピーします。", "현재 프레임의 Primary + v2 색보정을 복사해 이 프로젝트 안에서 사용합니다."],
  ["複製目前影格調色", "Copy current frame grade", "Copiar color del fotograma actual", "現在のフレームの調色をコピー", "현재 프레임 색보정 복사"],
  ["貼上調色", "Paste grade", "Pegar ajustes de color", "調色を貼り付け", "색보정 붙여넣기"],
  ["已複製：{value0} · 片段時間 {value1} 秒", "Copied: {value0} · clip time {value1} s", "Copiado: {value0} · tiempo del clip {value1} s", "コピー済み：{value0} · クリップ時刻 {value1} 秒", "복사됨: {value0} · 클립 시간 {value1}초"],
  ["貼上會取代整段片段的調色與色彩關鍵幀；位置關鍵幀、變速、音量與素材保持不變，可一次復原。", "Paste replaces the whole clip's grade and color keyframes. Position keyframes, speed, volume and media are preserved; one Undo restores the change.", "Pegar reemplaza el color y sus fotogramas clave en todo el clip. Se conservan posición, velocidad, volumen y medios; un paso de Deshacer lo restaura.", "貼り付けはクリップ全体の調色と色のキーフレームを置き換えます。位置のキーフレーム、速度、音量、素材は維持され、1回で元に戻せます。", "붙여넣기는 전체 클립의 색보정과 색상 키프레임을 바꿉니다. 위치 키프레임, 속도, 볼륨과 미디어는 유지되며 한 번의 실행 취소로 복원할 수 있습니다."],
  ["已複製目前影格的調色。", "Copied the current frame's grade.", "Se copió el color del fotograma actual.", "現在のフレームの調色をコピーしました。", "현재 프레임의 색보정을 복사했습니다."],
  ["已貼上調色，可一次復原。", "Pasted the grade; one Undo restores it.", "Ajustes pegados; un paso de Deshacer los restaura.", "調色を貼り付けました。1回で元に戻せます。", "색보정을 붙여넣었습니다. 한 번의 실행 취소로 복원할 수 있습니다."],
  ["尚未複製這個專案的調色。", "No grade has been copied for this project.", "No se han copiado ajustes para este proyecto.", "このプロジェクトの調色はまだコピーされていません。", "이 프로젝트에서 복사한 색보정이 없습니다."],
  ["目前只能複製或貼上影像內容片段的調色。", "Only video/image content clips support grade copy and paste.", "Solo los clips de vídeo o imagen permiten copiar y pegar ajustes de color.", "映像・画像のコンテンツクリップのみ調色をコピー・貼り付けできます。", "영상/이미지 콘텐츠 클립의 색보정만 복사하고 붙여넣을 수 있습니다."],
  ["調色取樣時間不合法。", "The grade sample time is invalid.", "El tiempo de muestreo de color no es válido.", "調色のサンプル時刻が無効です。", "색보정 샘플 시간이 올바르지 않습니다."],
  ["調色快照不合法。", "The grade snapshot is invalid.", "La instantánea de color no es válida.", "調色のスナップショットが無効です。", "색보정 스냅샷이 올바르지 않습니다."],
  ["調色快照引用不存在的 Look。", "The grade snapshot references an unavailable Look.", "La instantánea hace referencia a un Look no disponible.", "調色のスナップショットが存在しない Look を参照しています。", "색보정 스냅샷이 사용할 수 없는 Look을 참조합니다."],
  ["調色快照超過大小上限。", "The grade snapshot exceeds the size limit.", "La instantánea de color supera el límite de tamaño.", "調色のスナップショットがサイズ上限を超えています。", "색보정 스냅샷이 크기 제한을 초과합니다."],
];
