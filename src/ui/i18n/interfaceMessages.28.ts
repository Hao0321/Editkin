/** B2 timeline canvas and ripple gestures. Five-language source catalogue. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
  ["＋ 標題","＋ Title","＋ Título","＋ タイトル","＋ 제목"],
  ["刪除空隙","Delete gap","Eliminar hueco","隙間を削除","간격 삭제"],
  ["已移動標記，可復原。","Moved marker. Undo is available.","Marcador movido. Puedes deshacerlo.","マーカーを移動しました。取り消せます。","마커를 이동했습니다. 실행 취소할 수 있습니다."],
  ["重新命名標記","Rename marker","Renombrar marcador","マーカーの名前を変更","마커 이름 변경"],
  ["已重新命名標記，可復原。","Renamed marker. Undo is available.","Marcador renombrado. Puedes deshacerlo.","マーカーの名前を変更しました。取り消せます。","마커 이름을 변경했습니다. 실행 취소할 수 있습니다."],
  ["已刪除標記，可復原。","Deleted marker. Undo is available.","Marcador eliminado. Puedes deshacerlo.","マーカーを削除しました。取り消せます。","마커를 삭제했습니다. 실행 취소할 수 있습니다."],
  ["這次波紋調整會影響標題模板，還不能安全重排；原專案保持不變。","This ripple would affect a title template that cannot yet be safely rearranged. The project is unchanged.","Esta edición afectaría una plantilla de título que aún no se puede reorganizar con seguridad. El proyecto sigue igual.","このリップル編集は安全に再配置できないタイトルテンプレートに影響します。プロジェクトは変更されません。","이 리플 편집은 안전하게 재배치할 수 없는 제목 템플릿에 영향을 줍니다. 프로젝트는 그대로입니다."],
  ["已波紋修剪片段，後面內容一起移動；一次復原即可還原。","Ripple-trimmed the clip and moved later content together. Undo once to restore.","Se recortó el clip y se desplazó el contenido posterior. Deshaz una vez para restaurar.","クリップをリップルトリミングし、後の内容も移動しました。1回の取り消しで戻せます。","클립을 리플 트리밍하고 뒤의 내용을 함께 이동했습니다. 한 번 실행 취소하면 복원됩니다."],
  ["已刪除這個空隙，後面內容一起移動；一次復原即可還原。","Deleted this gap and moved later content together. Undo once to restore.","Se eliminó este hueco y se desplazó el contenido posterior. Deshaz una vez para restaurar.","この隙間を削除し、後の内容も移動しました。1回の取り消しで戻せます。","이 간격을 삭제하고 뒤의 내용을 함께 이동했습니다. 한 번 실행 취소하면 복원됩니다."],
  ["這裡沒有可以刪除的空隙。","There is no removable gap here.","Aquí no hay un hueco que eliminar.","ここには削除できる隙間がありません。","여기에는 삭제할 간격이 없습니다."],
  ["修剪長度必須是有效的正數。","The trim length must be a valid positive number.","La longitud del recorte debe ser un número positivo válido.","トリミングの長さは有効な正の数で指定してください。","트리밍 길이는 유효한 양수여야 합니다."],
  ["片段至少要保留一幀，請少修剪一點。","Keep at least one frame; trim a little less.","Conserva al menos un fotograma; recorta un poco menos.","少なくとも1フレームを残すよう、トリミング量を減らしてください。","최소 한 프레임을 남기도록 조금 덜 자르세요."],
  ["這段有追蹤內容，尚未能安全波紋修剪；原專案保持不變。","This clip has tracked content that cannot yet be ripple-trimmed safely. The project is unchanged.","Este clip tiene seguimiento que aún no se puede recortar con seguridad. El proyecto sigue igual.","追跡コンテンツを安全にリップルトリミングできません。プロジェクトは変更されません。","이 클립의 추적 콘텐츠는 아직 안전하게 리플 트리밍할 수 없습니다. 프로젝트는 그대로입니다."],
  ["有標題模板的整組片段只能在原軌道左右移動。","A group with title templates can only move horizontally on its original tracks.","Un grupo con plantillas de título solo puede moverse horizontalmente en sus pistas originales.","タイトルテンプレートがあるグループは元のトラック上で左右にのみ移動できます。","제목 템플릿이 있는 그룹은 원래 트랙에서 좌우로만 이동할 수 있습니다."],
  ["這裡沒有足夠的可用軌道放下整組片段。","There are not enough available tracks here for the whole group.","Aquí no hay suficientes pistas disponibles para todo el grupo.","グループ全体を配置できるトラックが足りません。","전체 그룹을 놓을 수 있는 트랙이 부족합니다."],
  ["專案剛剛有變更，這次移動沒有套用；請再試一次。","The project changed. This move was not applied; try again.","El proyecto cambió. No se aplicó el movimiento; inténtalo de nuevo.","プロジェクトが変更されたため移動は適用されませんでした。もう一度お試しください。","프로젝트가 변경되어 이동이 적용되지 않았습니다. 다시 시도하세요."],
];
