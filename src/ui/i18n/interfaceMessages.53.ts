/** W4-2 explicit original counter tick preparation in the existing saved template editor. */
export const INTERFACE_MESSAGES: ReadonlyArray<readonly [string,string,string,string,string]> = [
 ["計數音效","Counter sounds","Sonidos del contador","カウンター効果音","카운터 효과음"],
 ["使用本機原創 tick，先檢查數字節點，再由你加入；音效仍待試聽確認。","Use locally synthesized ticks. Check the number changes before adding them; listening review is pending.","Usa ticks sintetizados localmente. Revisa los cambios numéricos antes de añadirlos; la revisión auditiva está pendiente.","ローカルで合成した tick を使用します。数値の変化を確認してから追加してください。試聴確認は保留中です。","로컬에서 합성한 tick을 사용합니다. 숫자 변화를 확인한 뒤 추가하세요. 청취 검토는 대기 중입니다."],
 ["Tick 版本","Tick version","Versión del tick","Tick バージョン","Tick 버전"],
 ["音效軌道","Sound effect track","Pista de efectos de sonido","効果音トラック","효과음 트랙"],
 ["新增音效軌道（可一次復原）","New sound effect track (one Undo)","Nueva pista de efectos (un Deshacer)","新しい効果音トラック（1回で元に戻す）","새 효과음 트랙 (한 번에 실행 취소)"],
 ["檢查計數音效","Check counter sounds","Revisar sonidos del contador","カウンター効果音を確認","카운터 효과음 확인"],
 ["{count} 個數字節點，將加入 {selected} 個完整音效；略過 {skipped} 個重疊、尾端或超出上限的節點。","{count} number changes: {selected} complete sounds will be added; {skipped} overlapping, end-tail or over-limit changes are skipped.","{count} cambios numéricos: se añadirán {selected} sonidos completos; se omiten {skipped} cambios superpuestos, al final o por encima del límite.","数値の変化 {count} 件に対し、完全な効果音を {selected} 件追加します。重複・末尾・上限超過の {skipped} 件はスキップします。","숫자 변화 {count}개 중 완전한 효과음 {selected}개를 추가합니다. 겹침, 끝 구간 또는 한도 초과 {skipped}개는 건너뜁니다."],
 ["試聽這個 tick","Preview this tick","Escuchar este tick","この tick を試聴","이 tick 미리 듣기"],
 ["加入計數音效","Add counter sounds","Añadir sonidos del contador","カウンター効果音を追加","카운터 효과음 추가"],
 ["計數音效已取消，專案未變更。","Counter sounds cancelled. The project is unchanged.","Sonidos del contador cancelados. El proyecto no ha cambiado.","カウンター効果音をキャンセルしました。プロジェクトは変更されていません。","카운터 효과음을 취소했습니다. 프로젝트는 변경되지 않았습니다."],
 ["計數音效未能準備，請確認模板與音軌後重試。","Counter sounds could not be prepared. Check the template and audio track, then retry.","No se pudieron preparar los sonidos. Revisa la plantilla y la pista de audio y vuelve a intentarlo.","カウンター効果音を準備できませんでした。テンプレートと音声トラックを確認して再試行してください。","카운터 효과음을 준비하지 못했습니다. 템플릿과 오디오 트랙을 확인한 뒤 다시 시도하세요."],
 ["計數音效未能加入，專案變更或來源失效；請重新檢查。","Counter sounds were not added because the project changed or the source became invalid. Check again.","No se añadieron los sonidos porque el proyecto cambió o la fuente dejó de ser válida. Revisa de nuevo.","プロジェクトの変更または無効なソースにより、効果音を追加できませんでした。もう一度確認してください。","프로젝트가 변경되었거나 소스가 유효하지 않아 효과음을 추가하지 못했습니다. 다시 확인하세요."],
 ["已加入 {count} 個計數音效，可一次復原。","Added {count} counter sounds. Undo once to restore.","Se añadieron {count} sonidos del contador. Usa Deshacer una vez para restaurar.","カウンター効果音を {count} 件追加しました。1回で元に戻せます。","카운터 효과음 {count}개를 추가했습니다. 한 번에 실행 취소할 수 있습니다."],
];
