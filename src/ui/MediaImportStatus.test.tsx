import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {MediaImportStatus} from "./MediaImportStatus";
describe("visible import state",()=>{
 it("shows preparation without claiming timeline import complete",()=>{const html=renderToStaticMarkup(<MediaImportStatus state={{phase:"preparing",total:3,completed:1,failed:0,message:""}} onRetry={()=>{}}/>);expect(html).toContain("正在準備預覽 1/3");expect(html).toContain("準備好後才會加入時間軸");expect(html).not.toContain("重試失敗項目");});
 it("states that a listed library asset is placed while verification continues",()=>{const html=renderToStaticMarkup(<MediaImportStatus state={{phase:"preparing",total:1,completed:0,failed:0,message:"",timelineCommitted:true}} onRetry={()=>{}}/>);expect(html).toContain("正在驗證並最佳化 0/1");expect(html).toContain("片段已先放入時間軸");expect(html).not.toContain("準備好後才會加入時間軸");});
 it("retries source verification without pretending a provisional clip is playable",()=>{const html=renderToStaticMarkup(<MediaImportStatus state={{phase:"failed",total:1,completed:1,failed:1,message:"proxy failed",timelineCommitted:true}} onRetry={()=>{}}/>);expect(html).toContain("1 份來源驗證／預覽尚未完成");expect(html).toContain("重試來源驗證");expect(html).toContain("不會假裝可播放");expect(html).not.toContain("失敗項目沒有加入時間軸");});
 it("exposes partial failure and retry separately from expandable detail",()=>{const html=renderToStaticMarkup(<MediaImportStatus state={{phase:"partial",total:3,completed:3,failed:1,message:"fixture encoder failure"}} onRetry={()=>{}}/>);expect(html).toContain("1 份素材尚未完成匯入");expect(html).toContain("重試失敗項目");expect(html).toContain("<details>");expect(html).toContain("fixture encoder failure");expect(html).not.toContain("原專案保留不變");});
});
