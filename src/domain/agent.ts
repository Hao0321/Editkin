import { findCaption, findClip, findTrack } from "./editGraph";
import type { EditorCommand } from "./commands";
import type { EditProject } from "./types";

export interface AgentContext {
  selectedClipId?: string;
  selectedCaptionId?: string;
  playhead: number;
}

export interface AgentPlan {
  message: string;
  command: EditorCommand;
}

export function isSmartCutInstruction(instruction: string): boolean {
  const text = instruction.trim();
  if (/(智慧粗剪|自動粗剪|remove silence|smart cut)/i.test(text)) return true;
  return /(停頓|沉默|空白)/i.test(text) && /(自動|去掉|刪|移除|清掉)/i.test(text);
}

export function isAutomaticCaptionInstruction(instruction: string): boolean {
  return /(自動字幕|語音轉字幕|辨識字幕|雙語字幕|中英字幕|auto(?:matic)? captions?|bilingual captions?|transcribe)/i.test(instruction.trim());
}

export function isSceneSplitInstruction(instruction: string): boolean {
  return /(自動分鏡|場景切分|鏡頭切分|scene (?:split|detect)|detect scenes?)/i.test(instruction.trim());
}

export function isSemanticAutoEditInstruction(instruction: string): boolean {
  return /(智慧成片|自動成片|一鍵成片|重點剪輯|精華剪輯|highlight (?:edit|cut)|auto(?:matic)? edit)/i.test(instruction.trim());
}

function selected(project: EditProject, context: AgentContext): string {
  if (!context.selectedClipId) throw new Error("請先在 Timeline 選一個片段");
  findClip(project, context.selectedClipId);
  return context.selectedClipId;
}

function firstNumber(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

export function compileAgentInstruction(
  project: EditProject,
  instruction: string,
  context: AgentContext,
  newId = `clip-agent-${Date.now()}`,
): AgentPlan {
  const text = instruction.trim().toLowerCase();
  if (!text) throw new Error("請輸入想修改的內容");

  if (/(undo|復原|回上一步)/i.test(text)) {
    throw new Error("UNDO_SIGNAL");
  }
  if (/(redo|重做)/i.test(text)) {
    throw new Error("REDO_SIGNAL");
  }
  if (/(壓緊|移除空隙|刪除空隙|compact)/i.test(text)) {
    const clipId = selected(project, context);
    const trackId = findClip(project, clipId).trackId;
    findTrack(project, trackId);
    return { message: "已把選取軌道的片段壓緊。", command: { type: "compact_track", trackId } };
  }
  if (/(加字幕|新增字幕|add caption)/i.test(text)) {
    const match = instruction.match(/(?:字幕|caption)\s*[:：]\s*(.+)$/i);
    const captionText = match?.[1]?.trim();
    if (!captionText) throw new Error("請用「在 3 秒加字幕：字幕內容」告訴我文字");
    const start = firstNumber(text) ?? context.playhead;
    return {
      message: `已在 ${start.toFixed(2)} 秒加入字幕。`,
      command: { type: "add_caption", caption: { id: newId.replace(/^clip/, "caption"), text: captionText, start, duration: 3 } },
    };
  }
  if (/(字幕改成|修改字幕|caption to)/i.test(text)) {
    if (!context.selectedCaptionId) throw new Error("請先在 Timeline 選一段字幕");
    findCaption(project, context.selectedCaptionId);
    const match = instruction.match(/(?:改成|to)\s*[:：]?\s*(.+)$/i);
    if (!match?.[1]?.trim()) throw new Error("請告訴我要改成什麼文字");
    return {
      message: "已修改選取字幕。",
      command: { type: "update_caption", captionId: context.selectedCaptionId, patch: { text: match[1].trim() } },
    };
  }
  if (/(刪除選取|刪掉選取|delete selected)/i.test(text)) {
    if (context.selectedCaptionId) {
      findCaption(project, context.selectedCaptionId);
      return { message: "已刪除選取字幕。", command: { type: "delete_caption", captionId: context.selectedCaptionId } };
    }
    const clipId = selected(project, context);
    return { message: "已刪除選取片段並自動補上空隙。", command: { type: "ripple_delete_clip", clipId } };
  }
  if (/(刪掉前|刪除前|trim first)/i.test(text)) {
    const seconds = firstNumber(text);
    if (!seconds) throw new Error("請告訴我要裁掉前幾秒");
    const clipId = selected(project, context);
    return {
      message: `已裁掉選取片段開頭 ${seconds} 秒。`,
      command: { type: "trim_clip_start", clipId, seconds },
    };
  }
  if (/(刪掉後|刪除後|裁掉後|trim last)/i.test(text)) {
    const seconds = firstNumber(text);
    if (!seconds) throw new Error("請告訴我要裁掉片尾幾秒");
    const clipId = selected(project, context);
    return {
      message: `已裁掉選取片段結尾 ${seconds} 秒。`,
      command: { type: "trim_clip_end", clipId, seconds },
    };
  }
  if (/(音量|volume)/i.test(text)) {
    const percent = firstNumber(text);
    if (percent === undefined) throw new Error("請用百分比告訴我音量，例如：音量 80%");
    const clipId = selected(project, context);
    return {
      message: `已把選取片段音量設為 ${percent}%。`,
      command: { type: "set_clip_volume", clipId, volume: percent / 100 },
    };
  }
  if (/(移到|move)/i.test(text)) {
    const timelineStart = firstNumber(text);
    if (timelineStart === undefined) throw new Error("請告訴我要移到第幾秒");
    const clipId = selected(project, context);
    return {
      message: `已把選取片段移到 ${timelineStart} 秒。`,
      command: { type: "move_clip", clipId, timelineStart },
    };
  }
  if (/(切開|分割|split)/i.test(text)) {
    const statedTime = firstNumber(text);
    const at = statedTime ?? context.playhead;
    const clipId = selected(project, context);
    return {
      message: `已在 ${at.toFixed(2)} 秒分割選取片段。`,
      command: { type: "split_clip", clipId, at, newClipId: newId },
    };
  }

  throw new Error("目前可理解：在 5 秒切開、在 3 秒加字幕：內容、字幕改成內容、刪掉前／後 2 秒、音量 80%、刪除選取、移到 3 秒、壓緊空隙、復原。");
}
