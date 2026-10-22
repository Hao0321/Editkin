/** Preview eyedropper status, separate from formal output colour measurements. */
export const INTERFACE_MESSAGES:ReadonlyArray<readonly[string,string,string,string,string]>=[
['素材色彩標記需修正 · 輸出阻擋','Correct media colour tags · output blocked','Corrige las etiquetas de color · salida bloqueada','素材の色タグを修正 · 出力を停止','미디어 색상 태그 수정 필요 · 출력 차단'],
['素材色彩標記無法解讀，請先修正 Input Transform。','The media colour tags cannot be interpreted; correct the Input Transform first.','No se pueden interpretar las etiquetas de color; corrige primero el Input Transform.','素材の色タグを解釈できません。先に Input Transform を修正してください。','미디어 색상 태그를 해석할 수 없습니다. 먼저 Input Transform을 수정해주세요.'],
['滴管取色','Eyedropper','Cuentagotas','スポイト','스포이트'],
['取樣範圍','Sample area','Área de muestra','サンプル範囲','샘플 영역'],
['點選影像取色；方向鍵移動，Enter 取樣，Esc 結束。','Click the image to sample; move with arrows, sample with Enter, exit with Esc.','Haz clic en la imagen; usa las flechas para mover, Enter para tomar la muestra y Esc para salir.','画像をクリックして取色。矢印キーで移動、Enter で取色、Esc で終了。','이미지를 클릭해 색상을 읽습니다. 방향키로 이동하고 Enter로 읽고 Esc로 종료합니다.'],
['讀取目前預覽的 SDR 8-bit 像素；取色不修改調色。','Reads SDR 8-bit pixels from the current preview; sampling leaves the grade unchanged.','Lee píxeles SDR de 8 bits de la vista previa actual; no modifica la gradación.','現在のプレビューの SDR 8-bit ピクセルを読み取ります。調色は変更しません。','현재 미리보기의 SDR 8비트 픽셀을 읽습니다. 색보정은 변경하지 않습니다.'],
['原片預覽像素','Source preview pixels','Píxeles de la vista previa original','元映像のプレビューピクセル','원본 미리보기 픽셀'],
['調色預覽像素','Graded preview pixels','Píxeles de la vista previa con gradación','調色済みプレビューピクセル','색보정 미리보기 픽셀'],
['取色座標或影像尺寸不合法。','The sample position or image size is invalid.','La posición de muestra o el tamaño de imagen no es válido.','取色座標または画像サイズが無効です。','색상 위치 또는 이미지 크기가 잘못되었습니다.'],
['取色範圍不合法。','The sample area is invalid.','El área de muestra no es válida.','取色範囲が無効です。','색상 읽기 영역이 잘못되었습니다.'],
['取色像素資料不合法。','The sampled pixel data is invalid.','Los datos de píxeles no son válidos.','取色ピクセルデータが無効です。','색상 픽셀 데이터가 잘못되었습니다.'],
['這個位置沒有可取樣的不透明像素。','This position has no usable opaque pixels.','Esta posición no tiene píxeles opacos utilizables.','この位置には取色できる不透明ピクセルがありません。','이 위치에는 읽을 수 있는 불투명 픽셀이 없습니다.'],
['目前影格尚未就緒，請重新取色。','The current frame is not ready; sample again.','El fotograma actual no está listo; toma otra muestra.','現在のフレームの準備ができていません。もう一度取色してください。','현재 프레임이 준비되지 않았습니다. 다시 색상을 읽어주세요.'],
['請避開分割線取色。','Sample away from the split divider.','Toma la muestra fuera de la línea divisoria.','分割線を避けて取色してください。','분할선을 피해 색상을 읽어주세요.'],
['這個預覽無法讀取取色像素。','This preview cannot provide sampled pixels.','No se pueden leer píxeles de esta vista previa.','このプレビューから取色ピクセルを読み取れません。','이 미리보기에서 색상 픽셀을 읽을 수 없습니다.'],
['請在影像內取色，黑邊不計入。','Sample inside the image; letterboxing is excluded.','Toma la muestra dentro de la imagen; se excluyen los márgenes negros.','画像内で取色してください。黒帯は含めません。','이미지 안에서 색상을 읽어주세요. 검은 여백은 제외됩니다.'],
];
