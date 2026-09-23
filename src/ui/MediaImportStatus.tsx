import type {MediaImportState} from "../desktop/useCreativeLibrary";
import "./mediaImportStatus.css";
export function MediaImportStatus({state,onRetry}:{state:MediaImportState;onRetry:()=>void}){
 const background=state.timelineCommitted===true;
 const title=state.phase==="preparing"
  ? `${background?"正在驗證並最佳化":"正在準備預覽"} ${state.completed}/${state.total}`
  : state.failed
   ? `${state.failed} 份${background?"來源驗證／預覽尚未完成":"素材尚未完成匯入"}`
   : "素材匯入未完成";
 const detail=background
  ? state.phase==="preparing"
    ? "片段已先放入時間軸；來源驗證、代理檔與縮圖會在背景完成。"
    : "片段占位會保留，但來源驗證成功前不會假裝可播放；輸出仍會重新驗證。"
  : state.phase==="preparing"
   ? "準備好後才會加入時間軸，請稍候。"
   : "失敗項目沒有加入時間軸；其他已完成的剪輯不會回退。";
 return <section className="media-import-status" aria-live="polite" aria-atomic="true" data-testid="media-import-status"><div><strong>{title}</strong><span>{detail}</span></div>{state.failed>0&&state.phase!=="preparing"?<button type="button" onClick={onRetry}>{background?"重試來源驗證":"重試失敗項目"}</button>:null}{state.phase!=="preparing"?<details><summary>查看原因</summary><p>{state.message}</p></details>:null}</section>;
}
