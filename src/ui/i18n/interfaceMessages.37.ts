/** M2 2.8: independent saved graphic timing, through the existing revision. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["進場速度", "Entrance speed", "Velocidad de entrada", "登場の速さ", "등장 속도"],
  ["停留時間", "Hold time", "Tiempo de permanencia", "表示時間", "유지 시간"],
  ["退場速度", "Exit speed", "Velocidad de salida", "退場の速さ", "퇴장 속도"],
  ["{seconds} 秒", "{seconds} s", "{seconds} s", "{seconds} 秒", "{seconds}초"],
  ["已儲存模板進場速度", "Saved template entrance speed", "Velocidad de entrada de la plantilla guardada", "保存済みテンプレートの登場速度", "저장된 템플릿 등장 속도"],
  ["已儲存模板停留時間", "Saved template hold time", "Permanencia de la plantilla guardada", "保存済みテンプレートの表示時間", "저장된 템플릿 유지 시간"],
  ["已儲存模板退場速度", "Saved template exit speed", "Velocidad de salida de la plantilla guardada", "保存済みテンプレートの退場速度", "저장된 템플릿 퇴장 속도"],
  ["文字會保留閱讀所需時間；停留太長時請延長片段。調整後套用修改，再看一次成片。", "Text keeps the time needed for reading. Extend the clip for a longer hold. Apply changes, then preview the result.", "El texto conserva el tiempo de lectura. Alarga el clip para una permanencia mayor. Aplica los cambios y revisa el resultado.", "文字の読み取りに必要な時間は確保します。表示を長くする場合はクリップを延長してください。変更を適用し、映像を確認してください。", "글을 읽는 데 필요한 시간은 유지합니다. 더 오래 표시하려면 클립을 늘리세요. 변경 사항을 적용한 뒤 결과를 확인하세요."],
  ["目前保留原始模板時序；拖動滑桿後才會套用獨立節奏。", "Original template timing is retained. Move a slider to use independent timing.", "Se conserva el ritmo original. Mueve un control para usar un ritmo independiente.", "元のテンプレートのタイミングを保持しています。スライダーを動かすと個別のタイミングを使用します。", "원래 템플릿 타이밍을 유지합니다. 슬라이더를 움직이면 개별 타이밍을 사용합니다."],
  ["保留原始模板時序", "Keep original template timing", "Mantener el ritmo original", "元のテンプレートのタイミングを保持", "원래 템플릿 타이밍 유지"],
  ["模板沒有可調整的完整停留段。", "This template has no complete hold to adjust.", "Esta plantilla no tiene una permanencia completa que ajustar.", "このテンプレートには調整できる完全な表示区間がありません。", "이 템플릿에는 조절할 수 있는 완전한 유지 구간이 없습니다."],
  ["模板動畫超出片段範圍。", "The template animation exceeds the clip.", "La animación de la plantilla supera el clip.", "テンプレートの動きがクリップの範囲を超えています。", "템플릿 애니메이션이 클립 범위를 초과합니다."],
  ["模板缺少完整閱讀停留；請延長片段。", "Extend the clip to give the text enough reading time.", "Alarga el clip para dar al texto suficiente tiempo de lectura.", "文字を読む時間を確保するため、クリップを延長してください。", "글을 읽을 시간을 확보하려면 클립을 늘리세요."],
  ["進場與停留放不下完整影格；請延長片段。", "Extend the clip to fit the complete entrance and hold.", "Alarga el clip para incluir la entrada y la permanencia completas.", "登場と表示の全フレームを収めるため、クリップを延長してください。", "전체 등장과 유지 구간을 담으려면 클립을 늘리세요."],
  ["片段放不下進場、閱讀停留與退場；請延長片段或調快速度。", "The entrance, reading hold and exit do not fit. Extend the clip or increase the speed.", "La entrada, la lectura y la salida no caben. Alarga el clip o aumenta la velocidad.", "登場、読み取り、退場の時間が収まりません。クリップを延長するか、速度を上げてください。", "등장, 읽기 유지, 퇴장 시간이 맞지 않습니다. 클립을 늘리거나 속도를 높이세요."],
  ["動態縮短後有元素不足一影格；請調慢速度。", "An element would last less than one frame. Reduce the speed.", "Un elemento duraría menos de un fotograma. Reduce la velocidad.", "要素が1フレーム未満になります。速度を下げてください。", "요소가 한 프레임보다 짧아집니다. 속도를 낮추세요."],
];
