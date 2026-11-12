// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import type { OpenProjectResult } from "../desktop/types";
import type { ProjectSession } from "./projectSession";

export interface AgentProjectResult {
  path: string;
  projectId: string;
  projectName: string;
  workingCopy: boolean;
}

export function parseAgentProjectResults(value: string): AgentProjectResult[] {
  try {
    const entries: unknown = JSON.parse(value);
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is AgentProjectResult => entry && typeof entry === "object"
      && typeof entry.path === "string" && Boolean(entry.path.trim())
      && typeof entry.projectId === "string" && Boolean(entry.projectId.trim())
      && typeof entry.projectName === "string" && typeof entry.workingCopy === "boolean").slice(0, 5);
  } catch { return []; }
}

/** Explicit navigation only; a completed background edit cannot replace later content. */
export async function openAgentProjectResult(input: {
  result: AgentProjectResult;
  session: ProjectSession;
  load: (path: string) => Promise<OpenProjectResult>;
  confirm: (message: string) => boolean;
  open: (opened: OpenProjectResult) => void;
}): Promise<boolean> {
  const started = input.session.getSnapshot();
  if (started.savePending) throw new Error("目前專案正在儲存；完成後再開啟先前的剪輯結果。");
  if (started.dirty && !input.confirm("開啟先前的 Agent 剪輯結果會離開目前專案。尚未儲存的修改會被捨棄，要繼續嗎？")) return false;
  const opened = await input.load(input.result.path);
  const current = input.session.getSnapshot();
  if (current.sessionId !== started.sessionId || current.contentOwner !== started.contentOwner || current.savePending)
    throw new Error("載入期間目前專案又有變更；已保留目前剪輯，請再開啟一次結果。");
  if (!opened.project || opened.project.id !== input.result.projectId)
    throw new Error("先前的剪輯結果已移動或內容不符；未取代目前專案。");
  input.open({ ...opened, path: input.result.workingCopy ? undefined : input.result.path });
  return true;
}
