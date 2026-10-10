import { useEffect, useState } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { getClipSourceReplacementError } from "../domain/clipSourceReplacement";

type ReplacementCommand = Extract<EditorCommand, { type: "replace_clip_source" }>;

interface Props {
  project: EditProject;
  sessionId: number;
  clipId: string;
  expectedAssetId: string;
  onReplace: (command: ReplacementCommand) => void;
}

/** Select another imported source without changing or relinking the old asset. */
export function ClipSourceReplacementControls({ project, sessionId, clipId, expectedAssetId, onReplace }: Props) {
  const [assetId, setAssetId] = useState("");
  const [startFrame, setStartFrame] = useState("0");
  useEffect(() => { setAssetId(""); setStartFrame("0"); }, [sessionId, clipId, expectedAssetId]);

  const sources = project.assets.filter(asset => asset.kind === "video" && asset.id !== expectedAssetId);
  const frame = startFrame.trim() === "" ? Number.NaN : Number(startFrame);
  const command: ReplacementCommand = { type: "replace_clip_source", clipId, expectedAssetId, assetId, sourceStart: frame / project.fps };
  const error = !sources.length ? "先匯入另一段影片，再選擇要替換的素材。"
    : !assetId ? "請選擇替換影片。"
    : !Number.isSafeInteger(frame) || frame < 0 ? "起始影格必須是零或正整數。"
    : getClipSourceReplacementError(project, command);

  return <details className="inspector-section" data-testid="clip-source-replacement">
    <summary>替換影片 <small>保留時間與動態</small></summary>
    <div className="inspector-advanced-body">
      <label className="field-label">素材庫影片
        <select aria-label="替換影片來源" value={assetId} onChange={event => setAssetId(event.target.value)}>
          <option value="">選擇影片…</option>
          {sources.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
      </label>
      <label className="field-label">起始專案影格（{project.fps} fps）
        <input aria-label="替換影片起始專案影格" type="number" min="0" step="1" value={startFrame} onChange={event => setStartFrame(event.target.value)} />
      </label>
      <p className="caption-bilingual-hint">保留片段長度、裁切、浮空框與效果。換片後請重新檢查構圖、字幕和聲音。</p>
      {error && <small role="status">{error}</small>}
      <button type="button" className="primary-tool-action" disabled={Boolean(error)} onClick={() => {
        if (Number.isSafeInteger(frame) && frame >= 0 && !getClipSourceReplacementError(project, command)) onReplace(command);
      }}>替換並保留動態</button>
    </div>
  </details>;
}
