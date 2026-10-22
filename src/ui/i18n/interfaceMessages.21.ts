/** 1280×720 layout (2026-10-10): the compact 標題與圖卡 lane and its 「還有 N 個」 button, the one-row transport with
 * 「更多」, and two status lines that showed untranslated after adding titles in simple mode. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
 // 標題與圖卡 lane in simple mode (src/ui/Timeline.tsx).
 ["還有 {count} 個","{count} more","{count} más","あと {count} 件","{count}개 더"],
 ["還有 {count} 個標題或圖卡沒顯示，按一下全部顯示","{count} more titles or graphics are hidden. Click to show them all","Hay {count} títulos o gráficos más ocultos. Haz clic para verlos todos","表示されていないタイトルや図があと {count} 件あります。クリックするとすべて表示します","보이지 않는 제목이나 그래픽이 {count}개 더 있어요. 누르면 모두 보여요"],
 ["收起","Show less","Mostrar menos","折りたたむ","접기"],
 ["收起，只顯示兩排標題","Show less: only two rows of titles","Mostrar menos: solo dos filas de títulos","折りたたむ（タイトルは 2 段だけ表示）","접기: 제목을 두 줄만 보여요"],
 // One-row transport (src/ui/PlaybackControls.tsx).
 ["更多","More","Más","その他","더 보기"],
 ["更多播放控制","More playback controls","Más controles de reproducción","その他の再生操作","재생 조작 더 보기"],
 ["倒放、暫停、快轉和播放速度","Reverse, pause, forward and playback speed","Reversa, pausa, avanzar y velocidad de reproducción","逆再生・一時停止・早送り・再生速度","역재생, 일시 정지, 빨리 감기, 재생 속도"],
 // Status lines after adding titles (src/App.tsx, src/application/motionGraphicCreationOwner.ts), translated where shown.
 ["已在 {seconds} 秒加入可編輯的人名 BAR／單位 BAR；同時段舊 BAR 已自動替換。","Added name and organization bars at {seconds} s; the old ones there were replaced.","Barras de nombre y organización añadidas en {seconds} s; se reemplazaron las anteriores.","{seconds} 秒に名前バーと所属バーを追加し、同じ時間の古いバーを置き換えました。","{seconds}초에 이름 막대와 소속 막대를 넣고 같은 시간의 이전 막대는 바꿨어요."],
 ["已加入新版動態圖卡，實體字形已準備，可一次復原。","Added the new motion graphic. Its letter shapes are ready. One Undo removes it.","Se añadió el nuevo gráfico animado. Las formas de sus letras están listas. Un solo Deshacer lo quita.","新しいモーショングラフィックを追加しました。文字の形も準備できました。1 回の取り消しで元に戻せます。","새 모션 그래픽을 넣었어요. 글자 모양도 준비됐어요. 한 번 실행 취소하면 되돌릴 수 있어요."],
];
