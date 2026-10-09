// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
export type AgentToolDetail =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; terminalId: string };

export type AgentToolLocation = { path: string; line?: number };

export type AgentToolState = {
  toolCallId: string;
  toolName?: string;
  kitCommand?: string;
  toolKind?: string;
  text: string;
  requestedAction?: string;
  outcome?: string;
  status: string;
  details?: AgentToolDetail[];
  locations?: AgentToolLocation[];
};

const limited = (value: unknown, length: number) => String(value ?? "").slice(0, length);
const editkinActionTitles = new Map([
  ["discover_editkin_tools", "尋找剪輯工具"],
  ["inspect_editkin_tool", "查看剪輯工具說明"],
  ["get_editkin_task_guidance", "確認任務操作流程"],
  ["create_project", "建立專案"],
  ["get_project_summary", "讀取專案摘要"],
  ["get_timeline_window", "查看時間軸"],
  ["validate_project", "檢查專案"],
  ["apply_edit_commands", "修改時間軸"],
  ["auto_cut_silence", "剪除靜音"],
  ["auto_transcribe_captions", "產生字幕"],
  ["auto_split_scenes", "辨識場景切點"],
  ["auto_edit_highlights", "挑選精彩片段"],
  ["prepare_ai_material", "分析素材"],
  ["audit_autopilot_plan", "審查自動剪輯計畫"],
  ["get_autopilot_plan_structure", "讀取剪輯計畫格式"],
  ["validate_autopilot_plan_draft", "檢查剪輯計畫草稿"],
  ["apply_autopilot_plan", "套用自動剪輯計畫"],
  ["render_project", "輸出影片"],
  ["read_kit_resource", "讀取自動剪輯規則"],
  ["get_kit_plan_context", "整理剪輯計畫證據"],
  ["draft_kit_single_clip_plan", "起草單片段剪輯計畫"],
  ["finish_kit_single_clip_edit", "完成單片段剪輯"],
  ["draft_kit_two_clip_story_plan", "起草雙片段故事剪輯"],
  ["finish_kit_two_clip_edit", "完成雙片段剪輯"],
  ["run_kit_workflow", "執行自動剪輯流程"],
]);

function requestedEditAction(rawInput: any): string | undefined {
  if (rawInput?.name !== "apply_edit_commands") return undefined;
  const commands = rawInput?.arguments?.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100) return undefined;
  if (commands.length > 1) return `${commands.length} 項剪輯命令`;
  const command = commands[0];
  if (!command || typeof command !== "object") return undefined;
  if (command.type === "set_clip_volume" && typeof command.volume === "number"
    && Number.isFinite(command.volume) && command.volume >= 0 && command.volume <= 2)
    return `片段音量設為 ${Math.round(command.volume * 100)}%`;
  const labels: Record<string, string> = {
    rename_project: "重新命名專案", add_clip: "加入片段", split_clip: "切開片段",
    move_clip: "移動片段", move_clip_to_track: "移動片段到其他軌道",
    trim_clip_start: "修剪片段起點", trim_clip_end: "修剪片段終點",
    delete_clip: "刪除片段", ripple_delete_clip: "波紋刪除片段",
    add_caption: "新增字幕", update_caption: "修改字幕", delete_caption: "刪除字幕",
    set_clip_color: "調整片段色彩", set_clip_creative: "調整片段風格",
  };
  return typeof command.type === "string" ? labels[command.type] || "1 項剪輯命令" : undefined;
}

function kitWorkflowSummary(command: string, content: any[] | undefined): string | undefined {
  if (!content || !["create", "source-status", "source-cancel", "source-resume"].includes(command)) return undefined;
  const raw = content.find(block => block?.type === "content" && block.content?.type === "text")?.content?.text;
  if (typeof raw !== "string" || raw.length > 16_000) return undefined;
  let value: any;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value?.preparationId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.preparationId)) return undefined;
  const status = String(value.status || "");
  if (status === "COMPLETED") return "素材已驗證，流程已建立";
  if (status === "CREATING") return "素材已驗證，正在建立流程";
  if (status === "CANCELLED") return "素材準備已取消";
  if (status === "INTERRUPTED") return "準備中斷，可恢復";
  if (status === "UNCERTAIN") return "建立流程結果待查證";
  if (status === "FAILED") return "素材準備失敗";
  const phases: Record<string, string> = { hashing: "讀取原片", checking: "檢查副本", copying: "複製素材", verifying: "驗證副本", ready: "準備完成" };
  const phase = phases[String(value.progress?.phase || "")] || "準備素材";
  const done = Number(value.progress?.bytesDone), total = Number(value.progress?.bytesTotal);
  const percent = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? ` · ${Math.min(99, Math.floor(100 * done / total))}%` : "";
  return `${phase}${percent}${status === "CANCELLING" ? " · 正在取消" : ""}`;
}

function blockedKitOutcome(command: string, content: any[] | undefined): string | undefined {
  if (command !== "complete" || !content) return undefined;
  const raw = content.find(block => block?.type === "content" && block.content?.type === "text")?.content?.text;
  if (typeof raw !== "string" || raw.length > 16_000) return undefined;
  if (raw.includes("source colour tags are incomplete"))
    return "畫面證據無法建立：來源影片缺完整色彩標籤。請確認原片或製作保留已知色彩資訊的副本，再建立新流程；不要把語音改標成無對白。";
  if (raw.includes("source colour tags contradict the project interpretation"))
    return "畫面證據無法建立：專案色彩解讀與來源標籤衝突。請先核對並修正來源或解讀設定，再建立新流程。";
  try {
    const result = JSON.parse(raw);
    if (result?.status === "BLOCKED_REQUIRED_TRANSCRIPT")
      return "必要逐字稿未完成，流程已停止。請檢查素材語音與本機辨識結果後再建立新流程。";
    if (result?.status === "BLOCKED_VISUAL_EVIDENCE")
      return result.reasonCode === "contradictory-color-interpretation"
        ? "畫面證據無法建立：專案色彩解讀與來源標籤衝突。請先核對並修正來源或解讀設定，再建立新流程。"
        : "畫面證據無法建立：來源影片缺完整色彩標籤。請確認原片或製作保留已知色彩資訊的副本，再建立新流程；不要把語音改標成無對白。";
  } catch { /* A non-JSON tool error remains in the operation log. */ }
  return undefined;
}

export function mergeAcpToolUpdate(update: any, prior?: AgentToolState): AgentToolState {
  const toolName = typeof update?.name === "string" ? limited(update.name, 120) : prior?.toolName;
  const title = typeof update?.title === "string" ? limited(update.title, 300) : "";
  const gatewayCall = toolName?.endsWith("call_editkin_tool") || title.endsWith("call_editkin_tool");
  const rawAction = gatewayCall && typeof update?.rawInput?.name === "string"
    ? update.rawInput.name : "";
  const kitCall = toolName?.endsWith("run_kit_workflow") || title.endsWith("run_kit_workflow");
  const kitCommand = kitCall && typeof update?.rawInput?.command === "string" ? update.rawInput.command : prior?.kitCommand || "";
  const kitTitles: Record<string, string> = { create: "建立自動剪輯流程", "source-status": "查看素材準備進度",
    "source-cancel": "取消素材準備", "source-resume": "恢復素材準備" };
  const directAction = [...editkinActionTitles.keys()].find((name) => [toolName, title].some((value) => value === name || value?.endsWith(`_${name}`)));
  const friendlyTitle = editkinActionTitles.get(rawAction || directAction || "")
    || (prior && [...editkinActionTitles.values()].includes(prior.text) ? prior.text : "");
  const content = Array.isArray(update?.content) ? update.content.slice(0, 8) : undefined;
  const requestedAction = kitCommand ? kitWorkflowSummary(kitCommand, content) || prior?.requestedAction
    : gatewayCall ? requestedEditAction(update?.rawInput) || prior?.requestedAction : prior?.requestedAction;
  const outcome = kitCommand ? blockedKitOutcome(kitCommand, content) || prior?.outcome : prior?.outcome;
  const details: AgentToolDetail[] | undefined = content?.flatMap((block: any): AgentToolDetail[] => {
    if (block?.type === "content" && block.content?.type === "text")
      return [{ type: "text", text: limited(block.content.text, 8_000) }];
    if (block?.type === "diff" && typeof block.path === "string" && typeof block.newText === "string")
      return [{ type: "diff", path: limited(block.path, 500),
        ...(typeof block.oldText === "string" ? { oldText: limited(block.oldText, 4_000) } : {}),
        newText: limited(block.newText, 4_000) }];
    if (block?.type === "terminal" && typeof block.terminalId === "string")
      return [{ type: "terminal", terminalId: limited(block.terminalId, 120) }];
    return [];
  });
  const locations: AgentToolLocation[] | undefined = Array.isArray(update?.locations)
    ? update.locations.slice(0, 20).filter((item: any) => typeof item?.path === "string")
      .map((item: any) => ({ path: limited(item.path, 500),
        ...(Number.isInteger(item.line) && item.line >= 0 ? { line: item.line } : {}) }))
    : undefined;
  return {
    toolCallId: limited(update?.toolCallId || prior?.toolCallId, 256),
    toolName,
    kitCommand: kitCommand || undefined,
    toolKind: typeof update?.kind === "string" ? limited(update.kind, 40) : prior?.toolKind,
    text: kitTitles[kitCommand] || friendlyTitle || (title || prior?.text || "工具呼叫"),
    requestedAction,
    outcome,
    status: outcome ? "failed" : typeof update?.status === "string" ? limited(update.status, 40) : prior?.status || "pending",
    details: details ?? prior?.details,
    locations: locations ?? prior?.locations,
  };
}
