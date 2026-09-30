// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { mergeAcpToolUpdate } from "./acpToolContent";

describe("ACP tool updates", () => {
  it("keeps title and status when a partial update only supplies content", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "call-1", name: "editkin_call", title: "讀取專案", kind: "read", status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "call-1", status: "completed", content: [
      { type: "content", content: { type: "text", text: "已讀取 3 個片段" } },
    ], locations: [{ path: "C:\\work\\film.hao", line: 7 }] }, started);
    const later = mergeAcpToolUpdate({ toolCallId: "call-1" }, completed);
    expect(later).toMatchObject({ toolName: "editkin_call", toolKind: "read", text: "讀取專案", status: "completed",
      details: [{ type: "text", text: "已讀取 3 個片段" }], locations: [{ path: "C:\\work\\film.hao", line: 7 }] });
  });

  it("bounds tool output and keeps structured diffs without serializing raw input", () => {
    const update = mergeAcpToolUpdate({ toolCallId: "call-2", title: "Edit", rawInput: { credential: "private" },
      content: [{ type: "diff", path: "C:\\work\\a.txt", oldText: "a".repeat(9_000), newText: "b".repeat(9_000) },
        { type: "content", content: { type: "image", data: "a".repeat(9_000) } }] });
    expect(update.details).toHaveLength(1);
    expect(update.details?.[0]).toMatchObject({ type: "diff", path: "C:\\work\\a.txt" });
    expect(JSON.stringify(update)).not.toContain("private");
    expect(JSON.stringify(update).length).toBeLessThan(9_000);
  });

  it("labels Editkin actions without exposing raw tool arguments", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "call-3", name: "editkin_call_editkin_tool",
      title: "editkin_call_editkin_tool", rawInput: { name: "apply_edit_commands", arguments: { credential: "private" } }, status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "call-3", title: "editkin_call_editkin_tool", status: "completed" }, started);
    expect(completed).toMatchObject({ text: "修改時間軸", status: "completed" });
    expect(JSON.stringify(completed)).not.toContain("private");
    expect(mergeAcpToolUpdate({ toolCallId: "call-4", name: "editkin_read_kit_resource",
      title: "editkin_read_kit_resource", status: "completed" }).text).toBe("讀取自動剪輯規則");
    expect(mergeAcpToolUpdate({ toolCallId: "plan-context", title: "editkin_get_kit_plan_context",
      status: "completed" }).text).toBe("整理剪輯計畫證據");
    expect(mergeAcpToolUpdate({ toolCallId: "plan-shape", title: "editkin_call_editkin_tool",
      rawInput: { name: "get_autopilot_plan_structure", arguments: {} }, status: "completed" }).text).toBe("讀取剪輯計畫格式");
    expect(mergeAcpToolUpdate({ toolCallId: "plan-check", title: "editkin_call_editkin_tool",
      rawInput: { name: "validate_autopilot_plan_draft", arguments: {} }, status: "completed" }).text).toBe("檢查剪輯計畫草稿");
  });

  it("uses OpenCode rawInput when its gateway name exists only in title", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "call-5", title: "editkin_call_editkin_tool",
      rawInput: { name: "apply_edit_commands", arguments: { credential: "private" } }, status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "call-5", status: "completed", content: [
      { type: "content", content: { type: "text", text: '{"status":"GREEN","appliedCommandCount":1}' } },
    ] }, started);
    expect(completed).toMatchObject({ text: "修改時間軸", status: "completed",
      details: [{ type: "text", text: '{"status":"GREEN","appliedCommandCount":1}' }] });
    expect(JSON.stringify(completed)).not.toContain("private");
    expect(mergeAcpToolUpdate({ toolCallId: "call-7", title: "editkin_run_kit_workflow", status: "completed" }).text)
      .toBe("執行自動剪輯流程");
    expect(mergeAcpToolUpdate({ toolCallId: "call-schema", title: "editkin_inspect_editkin_tool", status: "completed" }).text)
      .toBe("查看剪輯工具說明");
    expect(mergeAcpToolUpdate({ toolCallId: "call-discover", title: "editkin_discover_editkin_tools", status: "completed" }).text)
      .toBe("尋找剪輯工具");
    expect(mergeAcpToolUpdate({ toolCallId: "call-draft", title: "editkin_draft_kit_single_clip_plan", status: "completed" }).text)
      .toBe("起草單片段剪輯計畫");
    expect(mergeAcpToolUpdate({ toolCallId: "call-6", title: "other_tool", content: [
      { type: "content", content: { type: "text", text: "output" } },
    ] }).text).toBe("other_tool");
  });

  it("shows only a bounded, allowlisted edit request in the tool card", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "call-volume", title: "editkin_call_editkin_tool", status: "in_progress",
      rawInput: { name: "apply_edit_commands", arguments: { projectPath: "C:\\private\\film.editkin.json", token: "private-token",
        commands: [{ type: "set_clip_volume", clipId: "secret-clip", volume: 0.65 }] } } });
    const completed = mergeAcpToolUpdate({ toolCallId: "call-volume", status: "completed" }, started);
    expect(completed).toMatchObject({ text: "修改時間軸", requestedAction: "片段音量設為 65%", status: "completed" });
    expect(JSON.stringify(completed)).not.toMatch(/private|secret-clip/);
    expect(mergeAcpToolUpdate({ title: "editkin_call_editkin_tool", rawInput: { name: "apply_edit_commands",
      arguments: { commands: [{ type: "rename_project", name: "Sensitive project" }] } } }).requestedAction).toBe("重新命名專案");
    expect(mergeAcpToolUpdate({ title: "editkin_call_editkin_tool", rawInput: { name: "apply_edit_commands",
      arguments: { commands: [{ type: "unrecognized", payload: "private" }] } } }).requestedAction).toBe("1 項剪輯命令");
  });

  it("shows source preparation progress without exposing local source paths", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "kit-source", title: "editkin_run_kit_workflow",
      rawInput: { command: "source-status", preparationId: "123e4567-e89b-12d3-a456-426614174000" }, status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "kit-source", status: "completed", content: [
      { type: "content", content: { type: "text", text: JSON.stringify({ status: "PREPARING", preparationId: "123e4567-e89b-12d3-a456-426614174000",
        progress: { phase: "copying", bytesDone: 60, bytesTotal: 300 }, sourcePath: "C:\\private\\video.mp4" }) } },
    ] }, started);
    expect(completed).toMatchObject({ text: "查看素材準備進度", requestedAction: "複製素材 · 20%", status: "completed" });
    expect(completed.requestedAction).not.toContain("private");
  });

  it("shows a terminal transcript blocker even when ACP marks the tool call completed", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "kit-prepare", title: "editkin_run_kit_workflow",
      rawInput: { command: "complete", token: "private-claim" }, status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "kit-prepare", status: "completed", content: [
      { type: "content", content: { type: "text", text: JSON.stringify({ status: "BLOCKED_REQUIRED_TRANSCRIPT",
        run: "C:\\private\\run", detail: "private recognizer stderr" }) } },
    ] }, started);
    expect(completed).toMatchObject({ text: "執行自動剪輯流程", status: "failed",
      outcome: "必要逐字稿未完成，流程已停止。請檢查素材語音與本機辨識結果後再建立新流程。" });
    expect(completed.outcome).not.toMatch(/private|run_kit_workflow/);
    expect(mergeAcpToolUpdate({ toolCallId: "other", title: "other_tool", status: "completed",
      content: [{ type: "content", content: { type: "text", text: '{"status":"BLOCKED_REQUIRED_TRANSCRIPT"}' } }] }).outcome)
      .toBeUndefined();
  });

  it("shows the visual evidence blocker without leaking the local source path", () => {
    const started = mergeAcpToolUpdate({ toolCallId: "kit-visual", title: "editkin_run_kit_workflow",
      rawInput: { command: "complete", token: "private-claim" }, status: "in_progress" });
    const completed = mergeAcpToolUpdate({ toolCallId: "kit-visual", status: "completed", content: [
      { type: "content", content: { type: "text",
        text: "Kit controller: source colour tags are incomplete at C:\\private\\film.mp4; do not retry the same packet" } },
    ] }, started);
    expect(completed).toMatchObject({ status: "failed", outcome: expect.stringContaining("來源影片缺完整色彩標籤") });
    expect(completed.outcome).not.toMatch(/private|film\.mp4/);
    const conflict = mergeAcpToolUpdate({ toolCallId: "kit-conflict", title: "editkin_run_kit_workflow",
      rawInput: { command: "complete" }, status: "completed", content: [
        { type: "content", content: { type: "text", text: "source colour tags contradict the project interpretation" } },
      ] });
    expect(conflict.outcome).toContain("色彩解讀與來源標籤衝突");
    const structured = mergeAcpToolUpdate({ toolCallId: "kit-visual-structured", title: "editkin_run_kit_workflow",
      rawInput: { command: "complete" }, status: "completed", content: [
        { type: "content", content: { type: "text", text: JSON.stringify({ status: "BLOCKED_VISUAL_EVIDENCE",
          reasonCode: "incomplete-color-tags", run: "C:\\private\\run" }) } },
      ] });
    expect(structured).toMatchObject({ status: "failed", outcome: expect.stringContaining("來源影片缺完整色彩標籤") });
    expect(structured.outcome).not.toContain("private");
  });
});
