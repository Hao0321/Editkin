/** W1-4/W1-8 personal LUT library service diagnostics. Desktop panel wiring follows separately. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
  ["LUT 素材庫未設定。", "The LUT library is not configured.", "La biblioteca LUT no está configurada.", "LUT ライブラリが設定されていません。", "LUT 라이브러리가 설정되지 않았습니다."],
  ["LUT 素材庫路徑或檔案不合法。", "The LUT library path or file is invalid.", "La ruta o el archivo de la biblioteca LUT no es válido.", "LUT ライブラリのパスまたはファイルが無効です。", "LUT 라이브러리 경로 또는 파일이 올바르지 않습니다."],
  ["LUT 素材庫不可經過連結路徑。", "The LUT library cannot use linked paths.", "La biblioteca LUT no puede usar rutas enlazadas.", "LUT ライブラリにはリンク経由のパスを使用できません。", "LUT 라이브러리에는 링크된 경로를 사용할 수 없습니다."],
  ["LUT 素材庫 metadata 超過 8 MiB 上限。", "LUT library metadata exceeds the 8 MiB limit.", "Los metadatos de la biblioteca LUT superan el límite de 8 MiB.", "LUT ライブラリのメタデータが上限の 8 MiB を超えています。", "LUT 라이브러리 메타데이터가 8 MiB 제한을 초과했습니다."],
  ["LUT 素材庫 metadata 不合法。", "LUT library metadata is invalid.", "Los metadatos de la biblioteca LUT no son válidos.", "LUT ライブラリのメタデータが無効です。", "LUT 라이브러리 메타데이터가 올바르지 않습니다."],
  ["LUT 素材庫有重複身分。", "The LUT library contains duplicate identities.", "La biblioteca LUT contiene identidades duplicadas.", "LUT ライブラリに重複した ID があります。", "LUT 라이브러리에 중복된 ID가 있습니다."],
  ["LUT 內容或色彩空間與調色引用不符。", "LUT content or color space does not match the grade reference.", "El contenido o espacio de color del LUT no coincide con la referencia de color.", "LUT の内容または色空間が調色の参照と一致しません。", "LUT 내용 또는 색 공간이 색보정 참조와 일치하지 않습니다."],
  ["LUT 內容超過 64 MiB 上限。", "LUT content exceeds the 64 MiB limit.", "El contenido del LUT supera el límite de 64 MiB.", "LUT の内容が上限の 64 MiB を超えています。", "LUT 내용이 64 MiB 제한을 초과했습니다."],
  ["LUT 匯入只接受 .cube 檔。", "LUT import accepts .cube files only.", "La importación LUT solo admite archivos .cube.", "LUT の読み込みは .cube ファイルのみ対応しています。", "LUT 가져오기는 .cube 파일만 지원합니다."],
];
