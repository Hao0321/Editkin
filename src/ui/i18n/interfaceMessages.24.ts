/** Simple mode decluttered (2026-10-11): the one-row top bar with ⚙ 設定 and ? 說明, the 進階模式 switch, the timeline's
 * small zoom, the panel that opens for what was picked, and ＋ 文字 never landing on top of existing text. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
 // The top bar (src/ui/SimpleEditorTopBar.tsx) and its ⚙ 設定 (src/ui/InterfaceSettings.tsx).
 ["說明","Help","Ayuda","ヘルプ","도움말"],
 ["儲存專案（Ctrl+S）","Save project (Ctrl+S)","Guardar proyecto (Ctrl+S)","プロジェクトを保存（Ctrl+S）","프로젝트 저장 (Ctrl+S)"],
 ["語言、大小、配色、專案比例、檔案和進階模式","Language, size, theme, aspect ratio, files and Advanced mode","Idioma, tamaño, tema, proporción, archivos y modo avanzado","言語、サイズ、テーマ、縦横比、ファイル、詳細モード","언어, 크기, 테마, 화면 비율, 파일, 고급 모드"],
 ["顯示全部專業工具","Shows every professional tool","Muestra todas las herramientas profesionales","すべてのプロ向けツールを表示します","모든 전문 도구를 보여 줘요"],
 ["關掉就回到簡單畫面","Turn it off to go back to the simple screen","Desactívalo para volver a la pantalla sencilla","オフにするとシンプルな画面に戻ります","끄면 간단한 화면으로 돌아가요"],
 // The timeline's zoom (src/ui/TimelineZoomControl.tsx) and its ruler (src/ui/Timeline.tsx).
 ["縮小時間軸","Zoom the timeline out","Alejar la línea de tiempo","タイムラインを縮小","타임라인 축소"],
 ["放大時間軸","Zoom the timeline in","Acercar la línea de tiempo","タイムラインを拡大","타임라인 확대"],
 ["拖曳放大或縮小時間軸","Drag to zoom the timeline in or out","Arrastra para acercar o alejar la línea de tiempo","ドラッグしてタイムラインを拡大・縮小","드래그해서 타임라인을 확대하거나 축소해요"],
 ["放大 {value0}%","Zoom {value0}%","Zoom {value0} %","ズーム {value0}%","확대 {value0}%"],
 ["顯示全部（也可以雙擊時間尺）","Show all (or double-click the time ruler)","Mostrar todo (o haz doble clic en la regla de tiempo)","すべて表示（時間ルーラーのダブルクリックでも可）","모두 표시(시간 눈금자를 두 번 클릭해도 돼요)"],
 ["點一下移動播放頭；雙擊顯示全部","Click to move the playhead; double-click to show all","Haz clic para mover el cabezal; doble clic para mostrar todo","クリックで再生位置を移動、ダブルクリックですべて表示","클릭하면 재생 위치가 이동하고, 두 번 클릭하면 모두 표시해요"],
 // The panel for what was picked (src/ui/Inspector.tsx in simple mode).
 ["收起調整面板","Close the adjust panel","Cerrar el panel de ajustes","調整パネルを閉じる","조정 패널 닫기"],
 // Status lines (src/App.tsx, src/ui/EditorShell.tsx).
 ["點一下片段或字幕，就能調整。","Click a clip or caption to adjust it.","Haz clic en un clip o subtítulo para ajustarlo.","クリップや字幕をクリックすると調整できます。","클립이나 자막을 클릭하면 조정할 수 있어요."],
 ["這裡已經有字幕，新文字放在 {time} 秒，接在它後面。","There is already a caption here, so the new text starts at {time} s, right after it.","Ya hay un subtítulo aquí, así que el texto nuevo empieza en {time} s, justo después.","ここにはすでに字幕があるので、新しい文字はその直後の {time} 秒から始まります。","여기에는 이미 자막이 있어서 새 글자는 바로 뒤인 {time}초부터 시작해요."],
 ["專案比例已改成 {ratio} {name}；素材位置與裁切仍可逐片調整。","The project is now {ratio} {name}. You can still adjust each clip's position and crop.","El proyecto ahora es {ratio} {name}. Aún puedes ajustar la posición y el recorte de cada clip.","プロジェクトを {ratio} {name} に変更しました。素材の位置と切り抜きはクリップごとに調整できます。","프로젝트를 {ratio} {name}(으)로 바꿨어요. 클립마다 위치와 자르기를 계속 조정할 수 있어요."],
];
