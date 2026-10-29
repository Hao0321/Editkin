import { describe, expect, it } from "vitest";
import en from "../ui/i18n/locales/en";
import es from "../ui/i18n/locales/es";
import ja from "../ui/i18n/locales/ja";
import ko from "../ui/i18n/locales/ko";
import { describeProblem, PROBLEM_WHAT } from "./plainProblems";
import { isTechnicalStatus, plainStatusMessageKeys, simplifyStatus, STATUS_EXPORTING_PERCENT, STATUS_NEUTRAL, type PlainStatus } from "./plainStatus";

const TECHNICAL = /h264_nvenc|nvenc|revision|ENOSPC|ENOENT|ffmpeg|0x[0-9a-f]+|C:\\|\bat\s|Resident output/i;

/** Everything the simple footer would actually show for a status (keys and source text). */
function shown(status: PlainStatus): string {
  switch (status.kind) {
    case "as-is": return "";
    case "message": return `${status.key} ${Object.values(status.values ?? {}).join(" ")}`;
    case "text": return status.text;
    case "problem": return `${status.label} ${status.what} ${status.todo}`;
  }
}

describe("simple-mode footer status in plain words", () => {
  it("leaves plain statuses exactly as they are", () => {
    for (const text of ["已刪除空軌道，可復原。", "選取片段後，直接告訴我你想怎麼改。", "失敗：模型尚未就緒", "已完成 · 仍需審片",
      "智慧成片失敗：請先加入自己的影片。\n原有修改仍保留，請重新執行。", "已切換 ACES 2.0 專業色彩管理。", "專案已切換為 16:9 YouTube 橫式；素材位置與裁切仍可逐片調整。",
      "Editkin 已更新到 0.12.0，請重新開啟。"]) {
      expect(isTechnicalStatus(text), text).toBe(false);
      expect(simplifyStatus(text), text).toEqual({ kind: "as-is" });
    }
  });

  it("drops encoder names and paths from a finished export: only the file name stays", () => {
    const source = "影片輸出完成：C:\\Users\\Hao\\My Videos\\旅行 vlog.mp4 · h264_nvenc · 尚未綁定美感審查 · 尚未取得人工品質認證";
    const status = simplifyStatus(source);
    expect(status).toEqual({ kind: "message", key: "影片輸出完成：{name}", values: { name: "旅行 vlog.mp4" }, detail: source });
    expect(shown(status)).not.toMatch(TECHNICAL);
  });

  it("drops revision numbers and keeps the plain sentence around them", () => {
    const source = "專案已被其他視窗或 Agent 更新（目前 revision 12，你的版本 11）；請重新開啟後再套用修改。";
    expect(simplifyStatus(source)).toEqual({ kind: "text", text: "專案已被其他視窗或 Agent 更新；請重新開啟後再套用修改。", detail: source });
    const profile = simplifyStatus("Workflow Profile r3 已由 Editkin 原子保存，Codex／Claude 會讀取同一份授權。");
    expect(profile.kind).toBe("text");
    expect(shown(profile)).not.toMatch(/\br3\b/);
  });

  it("turns an engine's full error text into 「輸出失敗：…」 with the plain cause and what to do", () => {
    const disk = simplifyStatus("Resident output service 失敗：ENOSPC: no space left on device, write");
    expect(disk).toMatchObject({ kind: "problem", label: "輸出失敗", what: PROBLEM_WHAT.diskFull });
    const gpu = simplifyStatus("ffmpeg exited with code 1: [h264_nvenc @ 0x55d2] OpenEncodeSessionEx failed: out of memory (10)\n    at encode (C:\\editkin\\render.ts:12:4)");
    expect(gpu).toMatchObject({ kind: "problem", label: "輸出失敗", what: PROBLEM_WHAT.gpuEncoder });
    for (const status of [disk, gpu]) {
      expect(shown(status)).not.toMatch(TECHNICAL);
      expect(status.kind === "problem" && status.detail).toMatch(/ENOSPC|h264_nvenc/);
    }
  });

  it("uses the export job's own cause, also after its panel closed, and shows measured progress", () => {
    const error = new Error("Resident worker exited: ENOSPC: no space left on device (h264_nvenc)");
    const problem = describeProblem("export", error);
    const failed = simplifyStatus(error.message, { job: { phase: "failed", kind: "video", problem } });
    expect(failed).toEqual({ kind: "problem", label: "輸出失敗", fallbackLabel: "輸出失敗", what: problem.what, todo: problem.todo, detail: problem.detail });
    expect(simplifyStatus(error.message, { exportProblem: problem })).toEqual(failed);
    expect(simplifyStatus("正在輸出影片…", { job: { phase: "running", kind: "video", progress: { fraction: 0.456 } } }))
      .toEqual({ kind: "message", key: STATUS_EXPORTING_PERCENT, values: { percent: 45 } });
    expect(simplifyStatus("正在輸出影片…", { job: { phase: "choosing", kind: "video" } })).toEqual({ kind: "message", key: "正在輸出影片…" });
    // Newer plain feedback from the creator's own edit is not hidden by the running export.
    expect(simplifyStatus("已刪除片段，可復原。", { job: { phase: "running", kind: "video", progress: { fraction: 0.5 } } })).toEqual({ kind: "as-is" });
  });

  it("keeps a plain message's meaning when only its detail was technical", () => {
    expect(simplifyStatus("自動配樂素材略過：ENOENT: no such file or directory, open 'D:\\music\\a.mp3'；其他自動剪輯照常完成。"))
      .toMatchObject({ kind: "text", text: "自動配樂素材略過；其他自動剪輯照常完成。" });
    expect(simplifyStatus("網頁版沒有本機 Whisper／FFmpeg 引擎，這項功能需要桌面版。")).toMatchObject({ kind: "text", text: "這項功能需要桌面版。" });
    expect(simplifyStatus("已開啟 D:\\作品\\我的旅行.editkin.json")).toMatchObject({ kind: "message", key: "已打開「{name}」", values: { name: "我的旅行" } });
  });

  it("never claims success or failure for an unknown technical text", () => {
    expect(simplifyStatus("<script>alert(\"bad\")</script>")).toMatchObject({ kind: "message", key: STATUS_NEUTRAL });
    expect(simplifyStatus("Unexpected token < in JSON at position 0")).toMatchObject({ kind: "problem", label: "沒有完成", what: PROBLEM_WHAT.unknown });
    // Words such as "Editkin" or "Agent" are not engine text.
    expect(isTechnicalStatus("已連接 Editkin Agent。")).toBe(false);
  });

  it("has all five languages for every message it can show", () => {
    const keys = [...plainStatusMessageKeys(), ...Object.values(PROBLEM_WHAT)];
    for (const locale of [en, es, ja, ko]) expect(keys.filter(key => !(key in locale))).toEqual([]);
  });
});
