/** Native personal LUT API; native dialog images/compiled delivery still require later verification. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
  ["LUT 素材庫請使用本機絕對路徑。", "Use an absolute local path for the LUT library.", "Use una ruta local absoluta para la biblioteca LUT.", "LUT ライブラリにはローカルの絶対パスを指定してください。", "LUT 라이브러리에 로컬 절대 경로를 사용하세요."],
  ["找到舊 LUT 素材庫，請先明確指定素材庫位置；原資料保持不變。", "An older LUT library exists. Specify its location before continuing; existing data is preserved.", "Existe una biblioteca LUT anterior. Especifique su ubicación antes de continuar; se conservan los datos.", "以前の LUT ライブラリが見つかりました。続行前に場所を指定してください。元のデータは保持されます。", "기존 LUT 라이브러리가 있습니다. 계속하기 전에 위치를 지정하세요. 기존 데이터는 유지됩니다."],
  ["選擇要匯入的 LUT", "Choose a LUT to import", "Seleccionar LUT para importar", "読み込む LUT を選択", "가져올 LUT 선택"],
  ["LUT 操作只允許主編輯視窗。", "LUT operations are allowed only in the main editor window.", "Las operaciones LUT solo se permiten en la ventana principal del editor.", "LUT 操作はメイン編集ウィンドウでのみ許可されています。", "LUT 작업은 기본 편집 창에서만 허용됩니다."],
  ["LUT 選取序號已用盡。", "The LUT selection sequence is exhausted.", "Se agotó la secuencia de selección LUT.", "LUT 選択の連番が上限に達しました。", "LUT 선택 순서 번호가 한도에 도달했습니다."],
  ["LUT 選取已更新，這次結果未套用。", "The LUT selection changed; this result was not applied.", "La selección LUT cambió; no se aplicó este resultado.", "LUT の選択が更新されたため、この結果は適用されませんでした。", "LUT 선택이 변경되어 이 결과는 적용되지 않았습니다."],
  ["LUT 正在匯入，請等候完成。", "The LUT is being imported. Wait for it to finish.", "Se está importando el LUT. Espere a que termine.", "LUT を読み込み中です。完了までお待ちください。", "LUT를 가져오는 중입니다. 완료될 때까지 기다려 주세요."],
  ["請重新選擇 LUT 檔案。", "Select the LUT file again.", "Seleccione de nuevo el archivo LUT.", "LUT ファイルを選び直してください。", "LUT 파일을 다시 선택하세요."],
];
