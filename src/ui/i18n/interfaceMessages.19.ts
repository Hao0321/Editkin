/** Simple-mode polish (2026-10-10): plain footer status (export progress and failures in plain words, the save state),
 * the recent projects on the easy start screen and the folded media search. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
 // Footer status in simple mode (src/application/plainStatus.ts).
 ["正在輸出 {percent}%","Exporting {percent}%","Exportando {percent}%","書き出し中 {percent}%","내보내는 중 {percent}%"],
 ["{label}：{what}","{label}: {what}","{label}: {what}","{label}：{what}","{label}: {what}"],
 ["輸出失敗","Export failed","La exportación falló","書き出しに失敗","내보내기 실패"],
 ["沒有完成","Didn't finish","No se completó","完了しませんでした","완료되지 않았어요"],
 ["影片輸出完成：{name}","Video exported: {name}","Vídeo exportado: {name}","動画を書き出しました：{name}","영상 내보내기 완료: {name}"],
 ["輸出完成。","Export finished.","Exportación terminada.","書き出しが完了しました。","내보내기를 마쳤어요."],
 ["已打開「{name}」","Opened “{name}”","Se abrió «{name}»","「{name}」を開きました","‘{name}’ 프로젝트를 열었어요"],
 ["已載入新的版本。","Loaded the newer version.","Se cargó la versión más reciente.","新しいバージョンを読み込みました。","새 버전을 불러왔어요."],
 ["已打開剪好的專案。","Opened the finished project.","Se abrió el proyecto terminado.","仕上がったプロジェクトを開きました。","완성된 프로젝트를 열었어요."],
 ["有新的訊息，點一下可以看詳細內容。","There's a new message. Click to see the details.","Hay un mensaje nuevo. Haz clic para ver los detalles.","新しいお知らせがあります。クリックすると詳しく見られます。","새 메시지가 있어요. 누르면 자세히 볼 수 있어요."],
 // Save state in simple mode (src/ui/saveStateLabel.ts).
 ["還沒儲存","Not saved yet","Aún sin guardar","まだ保存していません","아직 저장 안 됨"],
 ["還沒儲存（已自動備份）","Not saved yet (backed up automatically)","Aún sin guardar (con copia automática)","まだ保存していません（自動バックアップ済み）","아직 저장 안 됨 (자동 백업됨)"],
 ["還沒儲存，自動備份也失敗了","Not saved yet, and the automatic backup failed","Aún sin guardar, y la copia automática falló","まだ保存しておらず、自動バックアップも失敗しました","아직 저장 안 됐고 자동 백업도 실패했어요"],
 ["還沒儲存，請下載專案","Not saved yet: download the project","Aún sin guardar: descarga el proyecto","まだ保存していません。プロジェクトをダウンロードしてください","아직 저장 안 됨: 프로젝트를 내려받으세요"],
 ["還沒有修改","No changes yet","Aún no hay cambios","まだ変更はありません","아직 바뀐 내용이 없어요"],
 // Recent projects on the easy start screen (src/ui/easy/EasyScreens.tsx).
 ["上次打開：{when}","Last opened: {when}","Abierto por última vez: {when}","最後に開いた日：{when}","마지막으로 연 날: {when}"],
 ["今天 {time}","Today {time}","Hoy {time}","今日 {time}","오늘 {time}"],
 ["昨天","Yesterday","Ayer","昨日","어제"],
 ["{days} 天前","{days} days ago","Hace {days} días","{days} 日前","{days}일 전"],
 ["正在打開…","Opening…","Abriendo…","開いています…","여는 중…"],
 ["找不到這個檔案了，可能被移走或刪掉了。","This file can't be found. It may have been moved or deleted.","No se encuentra este archivo. Puede que se haya movido o borrado.","このファイルが見つかりません。移動または削除された可能性があります。","이 파일을 찾을 수 없어요. 옮겨졌거나 삭제됐을 수 있어요."],
 ["從清單移除","Remove from list","Quitar de la lista","リストから外す","목록에서 빼기"],
 // Folded media search (src/ui/ProjectMediaSearchControls.tsx).
 ["收起搜尋","Hide search","Ocultar búsqueda","検索を閉じる","검색 접기"],
];
